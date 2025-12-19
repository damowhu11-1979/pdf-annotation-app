import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Pen,
  Minus,
  Type,
  ArrowRight,
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
  PaintBucket,
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
  const [scale, setScale] = useState(1.5);
  const [fileName, setFileName] = useState("document.pdf");

  // Tools: 'cursor', 'pen', 'line', 'arrow', 'rect', 'circle', 'text', 'eraser'
  const [activeTool, setActiveTool] = useState('cursor');
  const [color, setColor] = useState('#EF4444');
  const [lineWidth, setLineWidth] = useState(3);
  const [isFilled, setIsFilled] = useState(false);

  // Annotations store: { pageNum: [ ... ] }
  const [annotations, setAnnotations] = useState({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState([]);
  const [startPoint, setStartPoint] = useState(null);

  // Text input overlay state
  const [textInput, setTextInput] = useState(null); // { x, y, text } in PDF coords
  const ignoreBlurRef = useRef(false);

  const canvasRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);

  // Panning
  const isPanning = useRef(false);
  const [isPanningState, setIsPanningState] = useState(false);
  const startPan = useRef({ x: 0, y: 0, sl: 0, st: 0 });

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
    reader.onload = async function (ev) {
      const typedarray = new Uint8Array(ev.target.result);
      try {
        const loadingTask = pdfLib.getDocument(typedarray);
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setPageNum(1);
        setAnnotations({});
        setTextInput(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNum, scale, pdfLib]);

  // Redraw annotations
  useEffect(() => {
    drawAnnotations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, pageNum, scale, currentPath, startPoint, isFilled, isDrawing]);

  // Wheel zoom (non-passive)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      e.preventDefault();
      const delta = -e.deltaY;

      if (e.ctrlKey) {
        setScale(s => Math.min(5, Math.max(0.5, s + (delta * 0.002))));
      } else {
        const zoomStep = 0.1;
        setScale(prevScale => {
          const newScale = delta > 0 ? prevScale + zoomStep : prevScale - zoomStep;
          return Math.min(4, Math.max(0.25, newScale));
        });
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const renderPage = async (num) => {
    if (!pdfDoc) return;

    renderRequestRef.current++;
    const requestId = renderRequestRef.current;

    if (renderTaskRef.current) {
      try { await renderTaskRef.current.cancel(); } catch (_) {}
    }

    try {
      const page = await pdfDoc.getPage(num);
      if (renderRequestRef.current !== requestId) return;

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

        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (renderRequestRef.current === requestId) {
          renderTaskRef.current = null;
          drawAnnotations();
        }
      }
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') return;
      console.error('Error rendering page:', error);
    }
  };

  // --- Pan Logic ---
  const handleContainerMouseDown = (e) => {
    if (e.button === 2 || e.button === 1 || (e.button === 0 && activeTool === 'cursor')) {
      e.preventDefault();
      const el = scrollContainerRef.current;
      if (!el) return;

      isPanning.current = true;
      setIsPanningState(true);
      startPan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    }
  };

  const handleContainerMouseMove = (e) => {
    if (isPanning.current && scrollContainerRef.current) {
      e.preventDefault();
      const el = scrollContainerRef.current;

      const dx = e.clientX - startPan.current.x;
      const dy = e.clientY - startPan.current.y;

      el.scrollLeft = startPan.current.sl - dx;
      el.scrollTop = startPan.current.st - dy;
    }
  };

  const handleContainerMouseUp = () => {
    isPanning.current = false;
    setIsPanningState(false);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
  };

  // --- Coordinates ---
  const getPdfCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;

    return { x: canvasX / scale, y: canvasY / scale };
  };

  // --- Text finalize ---
  const finalizeText = () => {
    if (ignoreBlurRef.current) return;
    if (!textInput) return;

    const t = (textInput.text || '').trim();
    if (!t) {
      setTextInput(null);
      return;
    }

    const newAnn = {
      type: 'text',
      x: textInput.x,
      y: textInput.y,
      text: textInput.text,
      color,
      size: 16
    };

    setAnnotations(prev => ({
      ...prev,
      [pageNum]: [...(prev[pageNum] || []), newAnn]
    }));
    setTextInput(null);
  };

  const handleTextSubmit = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finalizeText();
    }
  };

  // --- Drawing ---
  const startDrawing = (e) => {
    if (e.button !== 0) return;

    // Cursor tool -> pan handled by container
    if (activeTool === 'cursor') return;
    if (isPanning.current) return;

    const coords = getPdfCoordinates(e);

    if (activeTool === 'text') {
      // Commit existing textbox and start new one
      if (textInput) {
        ignoreBlurRef.current = true;
        finalizeText();
        // allow finalizeText() state to settle before placing new box
        setTimeout(() => { ignoreBlurRef.current = false; }, 50);
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
    } else if (['line', 'arrow', 'rect', 'circle'].includes(activeTool)) {
      canvasRef.current.tempEnd = coords;
      drawAnnotations();
    }
  };

  const stopDrawing = (e) => {
    if (!isDrawing) return;
    const coords = getPdfCoordinates(e);

    let newAnn = null;
    const baseProps = {
      color: activeTool === 'eraser' ? '#ffffff' : color,
      width: activeTool === 'eraser' ? 20 : lineWidth,
    };

    if (activeTool === 'pen' || activeTool === 'eraser') {
      newAnn = { ...baseProps, type: activeTool, points: currentPath };
    } else if (activeTool === 'line') {
      newAnn = { ...baseProps, type: 'line', start: startPoint, end: coords };
    } else if (activeTool === 'arrow') {
      newAnn = { ...baseProps, type: 'arrow', start: startPoint, end: coords };
    } else if (activeTool === 'rect') {
      newAnn = { ...baseProps, type: 'rect', start: startPoint, end: coords, filled: isFilled };
    } else if (activeTool === 'circle') {
      const radius = Math.sqrt(Math.pow(coords.x - startPoint.x, 2) + Math.pow(coords.y - startPoint.y, 2));
      newAnn = { ...baseProps, type: 'circle', center: startPoint, radius, filled: isFilled };
    }

    if (newAnn) {
      setAnnotations(prev => ({
        ...prev,
        [pageNum]: [...(prev[pageNum] || []), newAnn]
      }));
    }

    setIsDrawing(false);
    setCurrentPath([]);
    setStartPoint(null);
    if (canvasRef.current) canvasRef.current.tempEnd = null;
  };

  // --- Arrow drawing helper ---
  const strokeArrow = (ctx, x1, y1, x2, y2, headLenPx) => {
    // Line
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Head
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const a1 = angle - Math.PI / 7;
    const a2 = angle + Math.PI / 7;

    const hx1 = x2 - headLenPx * Math.cos(a1);
    const hy1 = y2 - headLenPx * Math.sin(a1);
    const hx2 = x2 - headLenPx * Math.cos(a2);
    const hy2 = y2 - headLenPx * Math.sin(a2);

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(hx1, hy1);
    ctx.moveTo(x2, y2);
    ctx.lineTo(hx2, hy2);
    ctx.stroke();
  };

  const drawAnnotations = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawItem = (ann) => {
      ctx.save();

      if (ann.type === 'eraser') ctx.globalCompositeOperation = 'destination-out';
      else ctx.globalCompositeOperation = 'source-over';

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
      } else if (ann.type === 'arrow') {
        const x1 = ann.start.x * scale;
        const y1 = ann.start.y * scale;
        const x2 = ann.end.x * scale;
        const y2 = ann.end.y * scale;
        const head = Math.max(10, ann.width * 3) * scale;
        strokeArrow(ctx, x1, y1, x2, y2, head);
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
    pageAnns.forEach(drawItem);

    // Preview while drawing
    if (isDrawing) {
      const tempEnd = canvas.tempEnd;
      if (activeTool === 'pen' || activeTool === 'eraser') {
        drawItem({
          type: activeTool,
          points: currentPath,
          color: activeTool === 'eraser' ? '#ffffff' : color,
          width: activeTool === 'eraser' ? 20 : lineWidth
        });
      } else if (startPoint && tempEnd) {
        if (activeTool === 'line') {
          drawItem({ type: 'line', start: startPoint, end: tempEnd, color, width: lineWidth });
        } else if (activeTool === 'arrow') {
          drawItem({ type: 'arrow', start: startPoint, end: tempEnd, color, width: lineWidth });
        } else if (activeTool === 'rect') {
          drawItem({ type: 'rect', start: startPoint, end: tempEnd, color, width: lineWidth, filled: isFilled });
        } else if (activeTool === 'circle') {
          const r = Math.sqrt(Math.pow(tempEnd.x - startPoint.x, 2) + Math.pow(tempEnd.y - startPoint.y, 2));
          drawItem({ type: 'circle', center: startPoint, radius: r, color, width: lineWidth, filled: isFilled });
        }
      }
    }
  };

  const undoLast = () => {
    const pageAnns = annotations[pageNum] || [];
    if (pageAnns.length === 0) return;
    setAnnotations(prev => ({ ...prev, [pageNum]: pageAnns.slice(0, -1) }));
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

    const strokeArrowExport = (ctx, x1, y1, x2, y2, headLenPx) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const angle = Math.atan2(y2 - y1, x2 - x1);
      const a1 = angle - Math.PI / 7;
      const a2 = angle + Math.PI / 7;

      const hx1 = x2 - headLenPx * Math.cos(a1);
      const hy1 = y2 - headLenPx * Math.sin(a1);
      const hx2 = x2 - headLenPx * Math.cos(a2);
      const hy2 = y2 - headLenPx * Math.sin(a2);

      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(hx1, hy1);
      ctx.moveTo(x2, y2);
      ctx.lineTo(hx2, hy2);
      ctx.stroke();
    };

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdfDoc.getPage(i);
      const originalViewport = page.getViewport({ scale: 1.0 });

      doc.addPage(
        [originalViewport.width, originalViewport.height],
        originalViewport.width > originalViewport.height ? 'l' : 'p'
      );

      const viewport = page.getViewport({ scale: exportScale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const pageAnns = annotations[i] || [];
      pageAnns.forEach(ann => {
        ctx.save();
        if (ann.type === 'eraser') ctx.globalCompositeOperation = 'destination-out';
        else ctx.globalCompositeOperation = 'source-over';

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
        } else if (ann.type === 'arrow') {
          const x1 = ann.start.x * s;
          const y1 = ann.start.y * s;
          const x2 = ann.end.x * s;
          const y2 = ann.end.y * s;
          const head = Math.max(10, ann.width * 3) * s;
          strokeArrowExport(ctx, x1, y1, x2, y2, head);
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

          {/* Tool Buttons */}
          <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border overflow-x-auto max-w-[50vw] sm:max-w-none no-scrollbar">
            <ToolButton
              active={activeTool === 'cursor'}
              onClick={() => setActiveTool('cursor')}
              icon={<MousePointer size={18} />}
              label="Select / Pan (Left Click Drag)"
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
              active={activeTool === 'arrow'}
              onClick={() => setActiveTool('arrow')}
              icon={<ArrowRight size={18} />}
              label="Arrow"
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

              <button
                onClick={() => setIsFilled(!isFilled)}
                className={`p-2 rounded flex items-center justify-center transition-all ${isFilled
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
            className="p-2 hover:bg-gray-100 rounded text-gray-600"
            title="Undo last action"
          >
            <RotateCcw size={18} />
          </button>

          <button
            onClick={() => setAnnotations(prev => ({ ...prev, [pageNum]: [] }))}
            className="p-2 hover:bg-red-50 text-red-500 rounded"
            title="Clear Page"
          >
            <Trash2 size={18} />
          </button>

          <div className="h-6 w-px bg-gray-300 mx-2"></div>

          <button
            onClick={exportPDF}
            disabled={!pdfDoc}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${!pdfDoc
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
        className="flex-1 overflow-auto bg-gray-200 relative cursor-default"
        onMouseDown={handleContainerMouseDown}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onContextMenu={handleContextMenu}
      >
        {!pdfDoc ? (
          <div className="flex flex-col items-center justify-center text-gray-400 h-full p-8">
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
          <div className="p-8 w-max h-max">
            <div
              className="relative shadow-xl origin-top-left"
              style={{
                width: 'fit-content',
                height: 'fit-content',
                cursor: isPanningState ? 'grabbing' : activeTool === 'cursor' ? 'grab' : 'crosshair'
              }}
            >
              <canvas ref={pdfCanvasRef} className="bg-white block" />

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
                  className="absolute z-50 flex items-center"
                  style={{
                    left: textInput.x * scale,
                    top: (textInput.y * scale) - 8
                  }}
                >
                  <input
                    autoFocus
                    value={textInput.text}
                    onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
                    onBlur={finalizeText}
                    onKeyDown={handleTextSubmit}
                    className="bg-white border border-blue-500 rounded px-2 py-1 outline-none shadow-lg min-w-[200px]"
                    style={{
                      font: `${16 * scale}px sans-serif`,
                      color: color,
                      lineHeight: 1.2
                    }}
                    placeholder="Type… (Enter to save)"
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                </div>
              )}
            </div>
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
    className={`p-2 rounded flex items-center justify-center transition-all ${active
      ? 'bg-blue-100 text-blue-700 shadow-inner'
      : 'hover:bg-gray-200 text-gray-600'
      }`}
    title={label}
  >
    {icon}
  </button>
);

export default App;
