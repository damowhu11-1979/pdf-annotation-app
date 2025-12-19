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
  PaintBucket,
  Sparkles,
  X,
  Loader2,
  Bot,
  Hand
} from 'lucide-react';

// External libraries
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

// --- Gemini API Helper ---
const callGemini = async (prompt, systemInstruction = "") => {
  const apiKey = ""; // Injected at runtime
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
  };

  let delay = 1000;
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        if (response.status === 429) throw new Error('Too Many Requests');
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
    } catch (error) {
      if (i === 4) throw error;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
};

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
  
  // AI State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [isPolishing, setIsPolishing] = useState(false);

  const canvasRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const renderTaskRef = useRef(null); // Ref to track active render task
  const renderRequestRef = useRef(0); // Ref to track the latest render request ID
  
  // Panning Refs
  const isPanning = useRef(false);
  const startPan = useRef({ x: 0, y: 0 });
  const ignoreBlurRef = useRef(false); // Helper for text tool

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
    
    // Increment request ID to invalidate any stale renders waiting on await
    renderRequestRef.current++;
    const requestId = renderRequestRef.current;

    // Cancel any currently running render task
    if (renderTaskRef.current) {
        try {
            await renderTaskRef.current.cancel();
        } catch (e) {
            // Cancellation throws an error, but it's expected
        }
    }

    try {
      const page = await pdfDoc.getPage(num);
      
      // If a newer render request came in while we were getting the page, abort this one
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
        
        // Final safety check: ensure no task is lingering
        if (renderTaskRef.current) {
            try {
                await renderTaskRef.current.cancel();
            } catch(e) {}
        }
        
        // Store the render task
        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;
        
        await renderTask.promise;
        
        // Only clear the ref if we are still the active request
        if (renderRequestRef.current === requestId) {
            renderTaskRef.current = null;
            drawAnnotations();
        }
      }
    } catch (error) {
      if (error.name === 'RenderingCancelledException') {
        // Ignore cancellation errors
        return;
      }
      console.error('Error rendering page:', error);
    }
  };

  // --- AI Features ---

  const handleAnalyzePage = async () => {
    if (!pdfDoc) return;
    setIsAnalyzing(true);
    setShowAnalysisModal(true);
    setAnalysisResult(""); // Clear previous result
    
    try {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      
      if (!text.trim()) {
        setAnalysisResult("No text found on this page to analyze. It might be an image-only PDF.");
        setIsAnalyzing(false);
        return;
      }

      const prompt = `Here is the text from page ${pageNum} of a PDF document: "${text}". \n\nPlease provide a concise summary of this page and list the top 3 key takeaways. Format the output with bold headings.`;
      const result = await callGemini(prompt, "You are a helpful PDF assistant.");
      setAnalysisResult(result);
    } catch (error) {
      setAnalysisResult("Failed to analyze page. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handlePolishText = async () => {
    if (!textInput || !textInput.text.trim()) return;
    setIsPolishing(true);
    
    try {
      const prompt = `Rewrite the following text to be more professional, grammatically correct, and concise: "${textInput.text}". Return ONLY the rewritten text, no explanations.`;
      const polishedText = await callGemini(prompt, "You are a professional editor.");
      setTextInput(prev => ({ ...prev, text: polishedText.trim() }));
    } catch (error) {
      console.error("Polishing failed", error);
    } finally {
      setIsPolishing(false);
    }
  };

  // --- Pan Logic ---

  const handleContainerMouseDown = (e) => {
    // Allow panning if:
    // 1. Right click (2) or Middle click (1)
    // 2. Left click (0) AND tool is 'cursor' (Pan Mode)
    if (e.button === 2 || e.button === 1 || (e.button === 0 && activeTool === 'cursor')) {
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
    
    // If tool is cursor, allow panning (bubble up to container)
    if (activeTool === 'cursor') return; 
    
    // Prevent drawing if we are currently panning
    if (isPanning.current) return;

    const coords = getPdfCoordinates(e);

    if (activeTool === 'text') {
      // If we are currently typing, clicking elsewhere should commit the text
      // and start a new box immediately.
      if (textInput) {
         // Mark that we are handling this manually so onBlur doesn't double-save
         ignoreBlurRef.current = true;
         
         if (textInput.text.trim()) {
             const pageAnns = annotations[pageNum] || [];
             const newAnn = {
                type: 'text',
                x: textInput.x,
                y: textInput.y,
                text: textInput.text,
                color,
                size: 16
             };
             // Save current annotation
             setAnnotations(prev => ({
               ...prev,
               [pageNum]: [...(prev[pageNum] || []), newAnn]
             }));
         }
         
         // Start new input at new location
         setTextInput({ x: coords.x, y: coords.y, text: '' });
         
         // Re-enable blur handling after a short delay
         setTimeout(() => { ignoreBlurRef.current = false; }, 50);
         return;
      }
      
      // If no text box active, start one
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
    // If ignoreBlur is true, it means startDrawing handled the save already
    if (ignoreBlurRef.current) return;

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
            {/* AI Assistant Button */}
            <button 
              onClick={handleAnalyzePage}
              disabled={!pdfDoc}
              className={`p-2 rounded text-indigo-600 hover:bg-indigo-50 flex items-center gap-2 transition-all ${!pdfDoc ? 'opacity-50 cursor-not-allowed' : ''}`}
              title="Analyze Page with AI"
            >
              <Sparkles size={18} />
              <span className="hidden sm:inline font-medium">Analyze Page</span>
            </button>
            <div className="h-6 w-px bg-gray-300 mx-2"></div>

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
              cursor: isPanning.current ? 'grabbing' : activeTool === 'cursor' ? 'grab' : 'crosshair'
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
                className="absolute z-50 flex items-center gap-2"
                style={{ 
                  left: textInput.x * scale, 
                  top: (textInput.y * scale) - 8 // Shifted up slightly
                }}
              >
                 <input
                  autoFocus
                  value={textInput.text}
                  onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
                  onBlur={finalizeText}
                  onKeyDown={handleTextSubmit}
                  className="bg-white border border-blue-500 rounded px-2 py-1 outline-none text-blue-900 placeholder-blue-300 shadow-lg min-w-[200px]"
                  style={{ 
                    font: `${16 * scale}px sans-serif`,
                    color: color,
                    lineHeight: 1.2
                  }}
                  placeholder="Type..."
                  onMouseDown={(e) => e.stopPropagation()} 
                />
                
                {/* AI Polish Button */}
                <button
                   onMouseDown={(e) => {
                     e.preventDefault(); // Prevent blur
                     e.stopPropagation();
                     handlePolishText();
                   }}
                   disabled={isPolishing || !textInput.text}
                   className="bg-indigo-600 text-white p-1.5 rounded-full shadow-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                   title="Rewrite with AI"
                >
                   {isPolishing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                </button>
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
      
      {/* Analysis Modal */}
      {showAnalysisModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="p-4 border-b flex justify-between items-center bg-indigo-50 rounded-t-xl">
              <div className="flex items-center gap-2 text-indigo-900 font-semibold">
                <Bot size={20} />
                <span>Page {pageNum} Analysis</span>
              </div>
              <button 
                onClick={() => setShowAnalysisModal(false)}
                className="p-1 hover:bg-indigo-100 rounded-full text-indigo-700"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
              {isAnalyzing ? (
                <div className="flex flex-col items-center justify-center py-8 text-gray-500 gap-3">
                  <Loader2 size={32} className="animate-spin text-indigo-500" />
                  <p>Analyzing text content...</p>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">
                  {analysisResult}
                </div>
              )}
            </div>
            
            <div className="p-4 border-t bg-gray-50 rounded-b-xl flex justify-end">
              <button
                onClick={() => setShowAnalysisModal(false)}
                className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium"
              >
                Close
              </button>
            </div>
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
