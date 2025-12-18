import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  Download, 
  Pen, 
  Minus, 
  Type, 
  ChevronLeft, 
  ChevronRight, 
  RotateCcw, 
  Trash2,
  Save,
  MousePointer,
  ZoomIn,
  ZoomOut,
  Square,
  Circle,
  Eraser,
  PaintBucket
} from 'lucide-react';

// External libraries
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

const App = () => {
  const [pdfLib, setPdfLib] = useState(null);
  const [jspdfLib, setJspdfLib] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.5); // Viewport zoom level
  const [fileName, setFileName] = useState("document.pdf");
  
  // Tools: 'cursor', 'pen', 'line', 'rect', 'circle', 'text', 'eraser'
  const [activeTool, setActiveTool] = useState('cursor');
  const [color, setColor] = useState('#EF4444');
  const [lineWidth, setLineWidth] = useState(3);
  const [isFilled, setIsFilled] = useState(false); // Toggle for shape filling
  
  // Annotations store: { pageNum: [ { type, coordinates (in PDF pt units), color, width, filled } ] }
  const [annotations, setAnnotations] = useState({}); 
  
  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState([]); // Array of {x, y} in PDF coordinates
  const [startPoint, setStartPoint] = useState(null); // {x, y} in PDF coordinates
  const [textInput, setTextInput] = useState(null); // { x, y, text } in PDF coordinates
  
  const canvasRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const renderTaskRef = useRef(null); // Ref to track active render task
  
  // Panning Refs
  const isPanning = useRef(false);
  const startPan = useRef({ x: 0, y: 0 });

  // Load Libraries
  useEffect(() => {
    const loadLibs = async () => {
      try {
        if (!window.pdfjsLib) {
          const script1 = document.createElement('script');
          script1.src = PDFJS_URL;
          script1.onload = () => {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            setPdfLib(window.pdfjsLib);
          };
          document.head.appendChild(script1);
        } else {
          setPdfLib(window.pdfjsLib);
        }

        if (!window.jspdf) {
          const script2 = document.createElement('script');
          script2.src = JSPDF_URL;
          script2.onload = () => {
            setJspdfLib(window.jspdf);
          };
          document.head.appendChild(script2);
        } else {
          setJspdfLib(window.jspdf);
        }
      } catch (e) {
        console.error("Failed to load libraries", e);
      }
    };
    loadLibs();
  }, []);

  // Handle File Upload
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !pdfLib) return;
    
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = async function(ev) {
      const typedarray = new Uint8Array(ev.target.result);
      try {
        const loadingTask = pdfLib.getDocument(typedarray);
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setPageNum(1);
        setAnnotations({});
      } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error parsing PDF. Please try another file.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Render Page
  useEffect(() => {
    if (!pdfDoc) return;
    renderPage(pageNum);
  }, [pdfDoc, pageNum, scale, pdfLib]);

  // Redraw annotations when relevant state changes
  useEffect(() => {
    drawAnnotations();
  }, [annotations, pageNum, scale, currentPath, startPoint, isFilled]);

  // Attach non-passive wheel listener to prevent scrolling
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      // Prevent default scrolling behavior completely
      e.preventDefault();
      
      // Zoom logic
      if (e.ctrlKey) {
         const delta = -e.deltaY;
         setScale(s => Math.min(5, Math.max(0.5, s + (delta * 0.002))));
      } else {
         const delta = -e.deltaY;
         const zoomStep = 0.1;
         setScale(prevScale => {
            const newScale = delta > 0 ? prevScale + zoomStep : prevScale - zoomStep;
            return Math.min(4, Math.max(0.25, newScale));
         });
      }
    };

    // { passive: false } is crucial to allow preventDefault() to work on wheel events
    container.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const renderPage = async (num) => {
    if (!pdfDoc) return;
    
    // Cancel any pending render task to avoid "same canvas" errors
    if (renderTaskRef.current) {
        try {
            await renderTaskRef.current.cancel();
        } catch (e) {
            // Cancellation throws an error, but it's expected
        }
    }

    try {
      const page = await pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale });
      
      const pdfCanvas = pdfCanvasRef.current;
      const drawCanvas = canvasRef.current;
      
      if (pdfCanvas && drawCanvas) {
        pdfCanvas.height = viewport.height;
        pdfCanvas.width = viewport.width;
        drawCanvas.height = viewport.height;
        drawCanvas.width = viewport.width;

        const renderContext = {
          canvasContext: pdfCanvas.getContext('2d'),
          viewport: viewport
        };
        
        // Store the render task
        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;
        
        await renderTask.promise;
        
        renderTaskRef.current = null;
        drawAnnotations();
      }
    } catch (error) {
      if (error.name === 'RenderingCancelledException') {
        // Ignore cancellation errors
        return;
      }
      console.error('Error rendering page:', error);
    }
  };

  // --- Pan Logic ---

  const handleContainerMouseDown = (e) => {
    // Middle click (1) or Right click (2) for panning
    if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      isPanning.current = true;
      startPan.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleContainerMouseMove = (e) => {
    if (isPanning.current && scrollContainerRef.current) {
      e.preventDefault();
      const dx = e.clientX - startPan.current.x;
      const dy = e.clientY - startPan.current.y;
      
      scrollContainerRef.current.scrollLeft -= dx;
      scrollContainerRef.current.scrollTop -= dy;
      
      startPan.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleContainerMouseUp = () => {
    isPanning.current = false;
  };

  const handleContextMenu = (e) => {
    e.preventDefault(); // Prevent default browser context menu
  };

  // --- Drawing Logic ---

  const getPdfCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    
    return {
      x: canvasX / scale,
      y: canvasY / scale
    };
  };

  const startDrawing = (e) => {
    // Only allow Left Click (0) for drawing
    if (e.button !== 0) return;
    if (activeTool === 'cursor') return;
    
    // Prevent drawing if we are currently panning
    if (isPanning.current) return;

    const coords = getPdfCoordinates(e);

    if (activeTool === 'text') {
      // If we are already typing, don't start a new one immediately. 
      // The blur event on the input will handle saving the previous one.
      if (textInput) {
        return;
      }
      setTextInput({ x: coords.x, y: coords.y, text: '' });
      return;
    }

    setIsDrawing(true);
    setStartPoint(coords);
    
    if (activeTool === 'pen' || activeTool === 'eraser') {
      setCurrentPath([coords]);
    }
  };

  const draw = (e) => {
    if (!isDrawing) return;
    const coords = getPdfCoordinates(e);
    
    if (activeTool === 'pen' || activeTool === 'eraser') {
      setCurrentPath(prev => [...prev, coords]);
    } else if (['line', 'rect', 'circle'].includes(activeTool)) {
      canvasRef.current.tempEnd = coords;
      drawAnnotations(); 
    }
  };

  const stopDrawing = (e) => {
    if (!isDrawing) return;
    const coords = getPdfCoordinates(e);
    
    const pageAnns = annotations[pageNum] || [];
    let newAnn = null;

    const baseProps = {
      color: activeTool === 'eraser' ? '#ffffff' : color,
      width: activeTool === 'eraser' ? 20 : lineWidth, 
    };

    if (activeTool === 'pen' || activeTool === 'eraser') {
      newAnn = { ...baseProps, type: activeTool, points: currentPath };
    } else if (activeTool === 'line') {
      newAnn = { ...baseProps, type: 'line', start: startPoint, end: coords };
    } else if (activeTool === 'rect') {
      newAnn = { ...baseProps, type: 'rect', start: startPoint, end: coords, filled: isFilled };
    } else if (activeTool === 'circle') {
      const radius = Math.sqrt(Math.pow(coords.x - startPoint.x, 2) + Math.pow(coords.y - startPoint.y, 2));
      newAnn = { ...baseProps, type: 'circle', center: startPoint, radius: radius, filled: isFilled };
    }

    if (newAnn) {
      setAnnotations({
        ...annotations,
        [pageNum]: [...pageAnns, newAnn]
      });
    }

    setIsDrawing(false);
    setCurrentPath([]);
    setStartPoint(null);
    if(canvasRef.current) canvasRef.current.tempEnd = null;
  };

  const handleTextSubmit = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finalizeText();
    }
  };

  const finalizeText = () => {
    // If textInput is null, we have nothing to save
    if (!textInput) return;
    
    // Check if text is empty
    if (!textInput.text.trim()) {
      setTextInput(null);
      return;
    }
    
    const pageAnns = annotations[pageNum] || [];
    const newAnn = {
      type: 'text',
      x: textInput.x,
      y: textInput.y,
      text: textInput.text,
      color,
      size: 16
    };

    setAnnotations({
      ...annotations,
      [pageNum]: [...pageAnns, newAnn]
    });
    setTextInput(null);
  };

  const drawAnnotations = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const drawItem = (ann, isPreview = false) => {
      ctx.save();
      
      if (ann.type === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
      } else {
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.width * scale; 
      ctx.fillStyle = ann.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (ann.type === 'pen' || ann.type === 'eraser') {
        ctx.beginPath();
        if (ann.points.length > 0) {
          ctx.moveTo(ann.points[0].x * scale, ann.points[0].y * scale);
          ann.points.forEach(p => ctx.lineTo(p.x * scale, p.y * scale));
        }
        ctx.stroke();
      } else if (ann.type === 'line') {
        ctx.beginPath();
        ctx.moveTo(ann.start.x * scale, ann.start.y * scale);
        ctx.lineTo(ann.end.x * scale, ann.end.y * scale);
        ctx.stroke();
      } else if (ann.type === 'rect') {
        const x = ann.start.x * scale;
        const y = ann.start.y * scale;
        const w = (ann.end.x - ann.start.x) * scale;
        const h = (ann.end.y - ann.start.y) * scale;
        
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        if (ann.filled) ctx.fill();
        ctx.stroke();
      } else if (ann.type === 'circle') {
        ctx.beginPath();
        ctx.arc(ann.center.x * scale, ann.center.y * scale, ann.radius * scale, 0, 2 * Math.PI);
        if (ann.filled) ctx.fill();
        ctx.stroke();
      } else if (ann.type === 'text') {
        ctx.font = `${ann.size * scale}px sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(ann.text, ann.x * scale, ann.y * scale);
      }
      
      ctx.restore();
    };

    const pageAnns = annotations[pageNum] || [];
    pageAnns.forEach(ann => drawItem(ann));

    if (isDrawing) {
      const tempEnd = canvas.tempEnd;
      if (activeTool === 'pen' || activeTool === 'eraser') {
        drawItem({
          type: activeTool,
          points: currentPath,
          color: activeTool === 'eraser' ? '#ffffff' : color,
          width: activeTool === 'eraser' ? 20 : lineWidth
        }, true);
      } else if (startPoint && tempEnd) {
        if (activeTool === 'line') {
           drawItem({ type: 'line', start: startPoint, end: tempEnd, color, width: lineWidth }, true);
        } else if (activeTool === 'rect') {
           drawItem({ type: 'rect', start: startPoint, end: tempEnd, color, width: lineWidth, filled: isFilled }, true);
        } else if (activeTool === 'circle') {
           const r = Math.sqrt(Math.pow(tempEnd.x - startPoint.x, 2) + Math.pow(tempEnd.y - startPoint.y, 2));
           drawItem({ type: 'circle', center: startPoint, radius: r, color, width: lineWidth, filled: isFilled }, true);
        }
      }
    }
  };

  const undoLast = () => {
    const pageAnns = annotations[pageNum] || [];
    if (pageAnns.length === 0) return;
    
    const newAnns = pageAnns.slice(0, -1);
    setAnnotations({
      ...annotations,
      [pageNum]: newAnns
    });
  };

  const exportPDF = async () => {
    if (!pdfDoc || !jspdfLib) return;
    const { jsPDF } = jspdfLib;
    
    const doc = new jsPDF({
      orientation: 'p',
      unit: 'pt',
      format: 'a4',
      putOnlyUsedFonts: true
    });
    
    doc.deletePage(1);
    const totalPages = pdfDoc.numPages;
    const exportScale = 2.0; 
    
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdfDoc.getPage(i);
      const originalViewport = page.getViewport({ scale: 1.0 });
      
      doc.addPage([originalViewport.width, originalViewport.height], originalViewport.width > originalViewport.height ? 'l' : 'p');
      
      const viewport = page.getViewport({ scale: exportScale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      
      await page.render({ canvasContext: ctx, viewport }).promise;
      
      const pageAnns = annotations[i] || [];
      
      pageAnns.forEach(ann => {
        ctx.save();
        if (ann.type === 'eraser') {
          ctx.globalCompositeOperation = 'destination-out';
        } else {
          ctx.globalCompositeOperation = 'source-over';
        }

        ctx.strokeStyle = ann.color;
        ctx.lineWidth = ann.width * exportScale;
        ctx.fillStyle = ann.color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        const s = exportScale;

        if (ann.type === 'pen' || ann.type === 'eraser') {
          ctx.beginPath();
          if (ann.points.length > 0) {
            ctx.moveTo(ann.points[0].x * s, ann.points[0].y * s);
            ann.points.forEach(p => ctx.lineTo(p.x * s, p.y * s));
          }
          ctx.stroke();
        } else if (ann.type === 'line') {
          ctx.beginPath();
          ctx.moveTo(ann.start.x * s, ann.start.y * s);
          ctx.lineTo(ann.end.x * s, ann.end.y * s);
          ctx.stroke();
        } else if (ann.type === 'rect') {
          const rx = ann.start.x * s;
          const ry = ann.start.y * s;
          const rw = (ann.end.x - ann.start.x) * s;
          const rh = (ann.end.y - ann.start.y) * s;
          
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          if (ann.filled) ctx.fill();
          ctx.stroke();
        } else if (ann.type === 'circle') {
          ctx.beginPath();
          ctx.arc(ann.center.x * s, ann.center.y * s, ann.radius * s, 0, 2 * Math.PI);
          if (ann.filled) ctx.fill();
          ctx.stroke();
        } else if (ann.type === 'text') {
          ctx.font = `${ann.size * s}px sans-serif`;
          ctx.textBaseline = 'top';
          ctx.fillText(ann.text, ann.x * s, ann.y * s);
        }
        ctx.restore();
      });
      
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      doc.addImage(imgData, 'JPEG', 0, 0, originalViewport.width, originalViewport.height);
    }
    
    doc.save(`edited_${fileName}`);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100 font-sans text-gray-800">
      {/* Header / Toolbar */}
      <div className="bg-white border-b shadow-sm p-4 flex flex-wrap items-center justify-between gap-4 z-10">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-lg border">
            <button 
              onClick={() => fileInputRef.current.click()}
              className="p-2 hover:bg-gray-200 rounded text-gray-700 flex items-center gap-2 text-sm font-medium"
            >
              <Upload size={18} />
              <span className="hidden sm:inline">Upload</span>
            </button>
            <input 
              ref={fileInputRef}
              type="file" 
              accept=".pdf" 
              className="hidden" 
              onChange={handleFileUpload}
            />
          </div>
          
          <div className="h-6 w-px bg-gray-300 mx-2"></div>

          <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border overflow-x-auto max-w-[50vw] sm:max-w-none no-scrollbar">
             <ToolButton 
              active={activeTool === 'cursor'} 
              onClick={() => setActiveTool('cursor')} 
              icon={<MousePointer size={18} />} 
              label="Select / Navigation" 
            />
            <ToolButton 
              active={activeTool === 'pen'} 
              onClick={() => setActiveTool('pen')} 
              icon={<Pen size={18} />} 
              label="Pen" 
            />
            <ToolButton 
              active={activeTool === 'eraser'} 
              onClick={() => setActiveTool('eraser')} 
              icon={<Eraser size={18} />} 
              label="Eraser" 
            />
            <div className="w-px h-6 bg-gray-200 mx-1"></div>
            <ToolButton 
              active={activeTool === 'line'} 
              onClick={() => setActiveTool('line')} 
              icon={<Minus size={18} />} 
              label="Line" 
            />
             <ToolButton 
              active={activeTool === 'rect'} 
              onClick={() => setActiveTool('rect')} 
              icon={<Square size={18} />} 
              label="Rectangle" 
            />
             <ToolButton 
              active={activeTool === 'circle'} 
              onClick={() => setActiveTool('circle')} 
              icon={<Circle size={18} />} 
              label="Circle" 
            />
            <ToolButton 
              active={activeTool === 'text'} 
              onClick={() => setActiveTool('text')} 
              icon={<Type size={18} />} 
              label="Text" 
            />
          </div>

          <div className="h-6 w-px bg-gray-300 mx-2"></div>

          {/* Style Controls */}
          {activeTool !== 'eraser' && (
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-center">
                  <input 
                    type="color" 
                    value={color} 
                    onChange={(e) => setColor(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer border-0 p-0 shadow-sm"
                    title="Color"
                  />
              </div>

              {/* Paint Bucket / Fill Toggle */}
              <button
                onClick={() => setIsFilled(!isFilled)}
                className={`p-2 rounded flex items-center justify-center transition-all ${
                    isFilled 
                    ? 'bg-blue-600 text-white shadow-md' 
                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                }`}
                title="Fill Shapes (Paint Bucket)"
              >
                 <PaintBucket size={18} />
              </button>

              <div className="flex flex-col w-24">
                  <input 
                    type="range" 
                    min="1" 
                    max="10" 
                    value={lineWidth} 
                    onChange={(e) => setLineWidth(parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                    title="Thickness"
                  />
                  <span className="text-[10px] text-gray-500 text-center">{lineWidth}px</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
            <button 
              onClick={undoLast}
              className="p-2 hover:bg-gray-100 rounded text-gray-600 tooltip"
              title="Undo last action"
            >
              <RotateCcw size={18} />
            </button>
            <button 
              onClick={() => setAnnotations({ ...annotations, [pageNum]: [] })}
              className="p-2 hover:bg-red-50 text-red-500 rounded"
              title="Clear Page"
            >
              <Trash2 size={18} />
            </button>
            <div className="h-6 w-px bg-gray-300 mx-2"></div>
            <button 
              onClick={exportPDF}
              disabled={!pdfDoc}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                !pdfDoc 
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed' 
                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
              }`}
            >
              <Save size={18} />
              <span className="hidden sm:inline">Save PDF</span>
            </button>
        </div>
      </div>

      {/* Main Workspace */}
      <div 
        ref={scrollContainerRef} 
        className="flex-1 overflow-auto bg-gray-200 relative p-8 flex justify-center cursor-default"
        onMouseDown={handleContainerMouseDown}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onContextMenu={handleContextMenu}
        // Removed React onWheel to use native passive: false event
      >
        {!pdfDoc ? (
          <div className="flex flex-col items-center justify-center text-gray-400 h-full">
            <div className="bg-white p-8 rounded-2xl shadow-sm text-center max-w-md">
                <Upload size={48} className="mx-auto mb-4 text-blue-500 opacity-50" />
                <h3 className="text-xl font-semibold text-gray-700 mb-2">Upload a Document</h3>
                <p className="mb-6">Select a PDF file to start annotating.</p>
                <button 
                    onClick={() => fileInputRef.current.click()}
                    className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
                >
                    Choose PDF
                </button>
            </div>
          </div>
        ) : (
          <div 
            className="relative shadow-xl origin-top-left" 
            style={{ 
              width: 'fit-content', 
              height: 'fit-content',
              cursor: isPanning.current ? 'grabbing' : activeTool === 'cursor' ? 'default' : 'crosshair'
            }}
          >
            {/* Layer 1: The PDF Render */}
            <canvas ref={pdfCanvasRef} className="bg-white block" />
            
            {/* Layer 2: The Drawing/Annotation Layer */}
            <canvas 
              ref={canvasRef}
              className="absolute top-0 left-0"
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
            />

            {/* Text Input Overlay */}
            {textInput && (
              <div
                className="absolute z-50"
                style={{ 
                  left: textInput.x * scale, 
                  top: (textInput.y * scale) - 4
                }}
              >
                 <input
                  autoFocus
                  value={textInput.text}
                  onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
                  onBlur={finalizeText}
                  onKeyDown={handleTextSubmit}
                  className="bg-transparent border border-blue-500 rounded px-1 py-0 outline-none text-blue-900 placeholder-blue-300 shadow-sm bg-white bg-opacity-50"
                  style={{ 
                    font: `${16 * scale}px sans-serif`,
                    color: color,
                    minWidth: '100px',
                    lineHeight: 1
                  }}
                  placeholder="Type..."
                  onMouseDown={(e) => e.stopPropagation()} 
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer / Pagination */}
      {pdfDoc && (
        <div className="bg-white border-t p-2 flex justify-between items-center px-6 z-10">
           <div className="flex items-center gap-2">
             <button onClick={() => setScale(s => Math.max(0.25, s - 0.25))} className="p-2 hover:bg-gray-100 rounded">
                <ZoomOut size={16} />
             </button>
             <span className="text-xs font-mono w-12 text-center">{Math.round(scale * 100)}%</span>
             <button onClick={() => setScale(s => Math.min(4, s + 0.25))} className="p-2 hover:bg-gray-100 rounded">
                <ZoomIn size={16} />
             </button>
           </div>

           <div className="flex items-center gap-4">
              <button 
                onClick={() => setPageNum(p => Math.max(1, p - 1))}
                disabled={pageNum <= 1}
                className="p-2 hover:bg-gray-100 rounded disabled:opacity-30"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="font-medium text-sm">
                Page {pageNum} of {pdfDoc.numPages}
              </span>
              <button 
                onClick={() => setPageNum(p => Math.min(pdfDoc.numPages, p + 1))}
                disabled={pageNum >= pdfDoc.numPages}
                className="p-2 hover:bg-gray-100 rounded disabled:opacity-30"
              >
                <ChevronRight size={20} />
              </button>
           </div>

           <div className="text-xs text-gray-400 max-w-[200px] truncate">
             {fileName}
           </div>
        </div>
      )}
    </div>
  );
};

// Helper Component for Tools
const ToolButton = ({ active, onClick, icon, label }) => (
  <button 
    onClick={onClick}
    className={`p-2 rounded flex items-center justify-center transition-all ${
      active 
      ? 'bg-blue-100 text-blue-700 shadow-inner' 
      : 'hover:bg-gray-200 text-gray-600'
    }`}
    title={label}
  >
    {icon}
  </button>
);

export default App;