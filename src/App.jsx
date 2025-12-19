import React, { useState, useEffect, useRef } from 'react';
import {
  Upload, Download, Pen, Minus, Type, ChevronLeft, ChevronRight,
  RotateCcw, Trash2, Save, MousePointer, ZoomIn, ZoomOut,
  Square, Circle, Eraser, PaintBucket
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

  // Tools: 'cursor', 'pen', 'line', 'rect', 'circle', 'text', 'eraser'
  const [activeTool, setActiveTool] = useState('cursor');
  const [color, setColor] = useState('#EF4444');
  const [lineWidth, setLineWidth] = useState(3);
  const [isFilled, setIsFilled] = useState(false);

  // Annotations store
  const [annotations, setAnnotations] = useState({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState([]);
  const [startPoint, setStartPoint] = useState(null);
  const [textInput, setTextInput] = useState(null);

  // Selection & moving
  const [selected, setSelected] = useState({ page: null, index: -1 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(null);

  const canvasRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);

  // Panning
  const isPanning = useRef(false);
  const startPan = useRef({ x: 0, y: 0 });

  // Load Libraries
  useEffect(() => {
    const loadLibs = async () => {
      try {
        if (!window.pdfjsLib) {
          const script1 = document.createElement('script');
          script1.src = PDFJS_URL;
          script1.crossOrigin = 'anonymous';
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
          script2.crossOrigin = 'anonymous';
          script2.onload = () => setJspdfLib(window.jspdf);
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
    reader.onload = async (ev) => {
      const typedarray = new Uint8Array(ev.target.result);
      try {
        const loadingTask = pdfLib.getDocument(typedarray);
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setPageNum(1);
        setAnnotations({});
        setSelected({ page: null, index: -1 });
      } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error parsing PDF. Please try another file.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Render Page
  useEffect(() => { if (pdfDoc) renderPage(pageNum); }, [pdfDoc, pageNum, scale, pdfLib]);
  useEffect(() => { drawAnnotations(); }, [annotations, pageNum, scale, currentPath, startPoint, isFilled, selected, dragging]);

  // Custom wheel zoom
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      e.preventDefault();

      if (e.ctrlKey) {
        const delta = -e.deltaY;
        setScale((s) => Math.min(5, Math.max(0.5, s + delta * 0.002)));
      } else {
        const delta = -e.deltaY;
        const zoomStep = 0.1;
        setScale((prev) => {
          const next = delta > 0 ? prev + zoomStep : prev - zoomStep;
          return Math.min(4, Math.max(0.25, next));
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
      try { await renderTaskRef.current.cancel(); } catch {}
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

        const renderContext = { canvasContext: pdfCanvas.getContext('2d'), viewport };
        if (renderTaskRef.current) { try { await renderTaskRef.current.cancel(); } catch {} }
        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;
        await renderTask.promise;

        if (renderRequestRef.current === requestId) {
          renderTaskRef.current = null;
          drawAnnotations();
        }
      }
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') console.error('Error rendering page:', error);
    }
  };

  // --- Geometry helpers (for hit-testing & moving) ---
  const pointDistanceToSegment = (px, py, x1, y1, x2, y2) => {
    const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let t = lenSq ? dot / lenSq : -1;
    t = Math.max(0, Math.min(1, t));
    const nx = x1 + t * C, ny = y1 + t * D;
    const dx = px - nx, dy = py - ny;
    return Math.hypot(dx, dy);
  };
  const insideRect = (x, y, r) => {
    const minX = Math.min(r.start.x, r.end.x);
    const maxX = Math.max(r.start.x, r.end.x);
    const minY = Math.min(r.start.y, r.end.y);
    const maxY = Math.max(r.start.y, r.end.y);
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  };
  const bboxOfPen = (pts) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    return { minX, minY, maxX, maxY };
  };

  // --- Pan Logic ---
  const handleContainerMouseDown = (e) => {
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
  const handleContainerMouseUp = () => { isPanning.current = false; };
  const handleContextMenu = (e) => e.preventDefault();

  // --- Drawing OR Selecting/Moving ---
  const getPdfCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    return { x: canvasX / scale, y: canvasY / scale };
  };

  const hitTestAt = (p) => {
    const pageAnns = annotations[pageNum] || [];
    const padding = 6 / scale; // pixels -> pdf pts
    for (let i = pageAnns.length - 1; i >= 0; i--) {
      const ann = pageAnns[i];
      if (ann.type === 'rect') {
        if (ann.filled) {
          if (insideRect(p.x, p.y, ann)) return i;
        } else {
          // treat border as wide band
          const nearEdge =
            Math.abs(p.x - ann.start.x) <= padding || Math.abs(p.x - ann.end.x) <= padding ||
            Math.abs(p.y - ann.start.y) <= padding || Math.abs(p.y - ann.end.y) <= padding;
          if (insideRect(p.x, p.y, ann) && nearEdge) return i;
        }
      } else if (ann.type === 'circle') {
        const d = Math.hypot(p.x - ann.center.x, p.y - ann.center.y);
        if (ann.filled) {
          if (d <= ann.radius + padding) return i;
        } else {
          if (Math.abs(d - ann.radius) <= padding) return i;
        }
      } else if (ann.type === 'line') {
        const d = pointDistanceToSegment(p.x, p.y, ann.start.x, ann.start.y, ann.end.x, ann.end.y);
        if (d <= padding) return i;
      } else if (ann.type === 'pen' || ann.type === 'eraser') {
        if (ann.points.length > 1) {
          for (let k = 0; k < ann.points.length - 1; k++) {
            const a = ann.points[k], b = ann.points[k + 1];
            const d = pointDistanceToSegment(p.x, p.y, a.x, a.y, b.x, b.y);
            if (d <= padding) return i;
          }
          const bb = bboxOfPen(ann.points);
          if (p.x >= bb.minX - padding && p.x <= bb.maxX + padding &&
              p.y >= bb.minY - padding && p.y <= bb.maxY + padding) {
            return i;
          }
        }
      } else if (ann.type === 'text') {
        const approxW = (ann.size * 0.6) * (ann.text?.length || 1) / scale;
        const approxH = (ann.size) / scale;
        const inBox = p.x >= ann.x && p.x <= ann.x + approxW && p.y >= ann.y && p.y <= ann.y + approxH;
        if (inBox) return i;
      }
    }
    return -1;
  };

  const startDrawing = (e) => {
    if (e.button !== 0) return;

    // MOVE/SELECT mode with cursor
    if (activeTool === 'cursor') {
      if (isPanning.current) return;
      const p = getPdfCoordinates(e);
      const idx = hitTestAt(p);
      if (idx !== -1) {
        setSelected({ page: pageNum, index: idx });
        setDragging(true);
        dragStartRef.current = { p0: p };
      } else {
        setSelected({ page: null, index: -1 });
      }
      return;
    }

    // Drawing modes
    if (activeTool === 'text') {
      if (!textInput) setTextInput({ x: getPdfCoordinates(e).x, y: getPdfCoordinates(e).y, text: '' });
      return;
    }

    const coords = getPdfCoordinates(e);
    setIsDrawing(true);
    setStartPoint(coords);
    if (activeTool === 'pen' || activeTool === 'eraser') setCurrentPath([coords]);
  };

  const draw = (e) => {
    const coords = getPdfCoordinates(e);

    // Dragging selected
    if (dragging && selected.page === pageNum && selected.index > -1) {
      const { p0 } = dragStartRef.current || { p0: coords };
      const dx = coords.x - p0.x;
      const dy = coords.y - p0.y;
      dragStartRef.current = { p0: coords };

      setAnnotations(prev => {
        const copy = { ...prev };
        const arr = [...(copy[pageNum] || [])];
        const ann = { ...arr[selected.index] };

        if (ann.type === 'line') {
          ann.start = { x: ann.start.x + dx, y: ann.start.y + dy };
          ann.end = { x: ann.end.x + dx, y: ann.end.y + dy };
        } else if (ann.type === 'rect') {
          ann.start = { x: ann.start.x + dx, y: ann.start.y + dy };
          ann.end   = { x: ann.end.x + dx, y: ann.end.y + dy };
        } else if (ann.type === 'circle') {
          ann.center = { x: ann.center.x + dx, y: ann.center.y + dy };
        } else if (ann.type === 'pen' || ann.type === 'eraser') {
          ann.points = ann.points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }));
        } else if (ann.type === 'text') {
          ann.x += dx; ann.y += dy;
        }

        arr[selected.index] = ann;
        copy[pageNum] = arr;
        return copy;
      });

      return; // don't draw new content while dragging
    }

    // Draw new content
    if (!isDrawing) return;
    if (activeTool === 'pen' || activeTool === 'eraser') {
      setCurrentPath(prev => [...prev, coords]);
    } else if (['line', 'rect', 'circle'].includes(activeTool)) {
      canvasRef.current.tempEnd = coords;
      drawAnnotations();
    }
  };

  const stopDrawing = () => {
    // End move
    if (dragging) {
      setDragging(false);
      dragStartRef.current = null;
      return;
    }

    if (!isDrawing) return;
    const tempEnd = canvasRef.current?.tempEnd || null;

    const pageAnns = annotations[pageNum] || [];
    let newAnn = null;
    const baseProps = { color: activeTool === 'eraser' ? '#ffffff' : color, width: activeTool === 'eraser' ? 20 : lineWidth };

    if (activeTool === 'pen' || activeTool === 'eraser') {
      newAnn = { ...baseProps, type: activeTool, points: currentPath };
    } else if (activeTool === 'line' && startPoint && tempEnd) {
      newAnn = { ...baseProps, type: 'line', start: startPoint, end: tempEnd };
    } else if (activeTool === 'rect' && startPoint && tempEnd) {
      newAnn = { ...baseProps, type: 'rect', start: startPoint, end: tempEnd, filled: isFilled };
    } else if (activeTool === 'circle' && startPoint && tempEnd) {
      const r = Math.hypot(tempEnd.x - startPoint.x, tempEnd.y - startPoint.y);
      newAnn = { ...baseProps, type: 'circle', center: startPoint, radius: r, filled: isFilled };
    }

    if (newAnn) setAnnotations({ ...annotations, [pageNum]: [...pageAnns, newAnn] });

    setIsDrawing(false);
    setCurrentPath([]);
    setStartPoint(null);
    if (canvasRef.current) canvasRef.current.tempEnd = null;
  };

  const handleTextSubmit = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finalizeText();
    }
  };

  const finalizeText = () => {
    if (!textInput) return;
    if (!textInput.text.trim()) { setTextInput(null); return; }

    const pageAnns = annotations[pageNum] || [];
    const newAnn = { type: 'text', x: textInput.x, y: textInput.y, text: textInput.text, color, size: 16 };
    setAnnotations({ ...annotations, [pageNum]: [...pageAnns, newAnn] });
    setTextInput(null);
  };

  const drawAnnotations = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawItem = (ann, i) => {
      ctx.save();
      ctx.globalCompositeOperation = ann.type === 'eraser' ? 'destination-out' : 'source-over';
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

      // selection highlight
      if (selected.page === pageNum && selected.index === i) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,255,0.6)';

        if (ann.type === 'rect') {
          const x = ann.start.x * scale;
          const y = ann.start.y * scale;
          const w = (ann.end.x - ann.start.x) * scale;
          const h = (ann.end.y - ann.start.y) * scale;
          ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
        } else if (ann.type === 'circle') {
          ctx.beginPath();
          ctx.arc(ann.center.x * scale, ann.center.y * scale, Math.max(8, ann.radius * scale + 6), 0, 2 * Math.PI);
          ctx.stroke();
        } else if (ann.type === 'line') {
          ctx.beginPath();
          ctx.moveTo(ann.start.x * scale, ann.start.y * scale);
          ctx.lineTo(ann.end.x * scale, ann.end.y * scale);
          ctx.stroke();
        } else if (ann.type === 'pen' || ann.type === 'eraser') {
          const bb = bboxOfPen(ann.points);
          ctx.strokeRect(bb.minX * scale - 3, bb.minY * scale - 3, (bb.maxX - bb.minX) * scale + 6, (bb.maxY - bb.minY) * scale + 6);
        } else if (ann.type === 'text') {
          const approxW = (ann.size * 0.6) * (ann.text?.length || 1);
          const approxH = ann.size;
          ctx.strokeRect(ann.x * scale - 3, ann.y * scale - 3, approxW + 6, approxH + 6);
        }
        ctx.restore();
      }
    };

    (annotations[pageNum] || []).forEach((ann, i) => drawItem(ann, i));

    if (isDrawing) {
      const tempEnd = canvas.tempEnd;
      const preview = (ann) => drawItem(ann, -1);
      if (activeTool === 'pen' || activeTool === 'eraser') {
        preview({ type: activeTool, points: currentPath, color: activeTool === 'eraser' ? '#ffffff' : color, width: activeTool === 'eraser' ? 20 : lineWidth });
      } else if (startPoint && tempEnd) {
        if (activeTool === 'line') preview({ type: 'line', start: startPoint, end: tempEnd, color, width: lineWidth });
        if (activeTool === 'rect') preview({ type: 'rect', start: startPoint, end: tempEnd, color, width: lineWidth, filled: isFilled });
        if (activeTool === 'circle') {
          const r = Math.hypot(tempEnd.x - startPoint.x, tempEnd.y - startPoint.y);
          preview({ type: 'circle', center: startPoint, radius: r, color, width: lineWidth, filled: isFilled });
        }
      }
    }
  };

  const undoLast = () => {
    const pageAnns = annotations[pageNum] || [];
    if (pageAnns.length === 0) return;
    setAnnotations({ ...annotations, [pageNum]: pageAnns.slice(0, -1) });
    setSelected({ page: null, index: -1 });
  };

  // Smart Fill toggle (also updates last rect/circle immediately)
  const toggleFill = () => {
    setIsFilled(prev => {
      const next = !prev;

      setAnnotations(prevAnns => {
        const pageAnns = prevAnns[pageNum] || [];
        if (pageAnns.length === 0) return prevAnns;

        const lastIndex = pageAnns.length - 1;
        const last = pageAnns[lastIndex];

        if (last?.type === 'rect' || last?.type === 'circle') {
          const updated = [...pageAnns];
          updated[lastIndex] = { ...last, filled: next };
          return { ...prevAnns, [pageNum]: updated };
        }
        return prevAnns;
      });

      return next;
    });
  };

  const exportPDF = async () => {
    if (!pdfDoc || !jspdfLib) return;
    const { jsPDF } = jspdfLib;

    const doc = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4', putOnlyUsedFonts: true });
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

      (annotations[i] || []).forEach(ann => {
        ctx.save();
        ctx.globalCompositeOperation = ann.type === 'eraser' ? 'destination-out' : 'source-over';
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
          const rx = ann.start.x * s, ry = ann.start.y * s;
          const rw = (ann.end.x - ann.start.x) * s, rh = (ann.end.y - ann.start.y) * s;
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
    <div className="flex flex-col h-screen bg-gray-100 text-gray-800">
      {/* Header / Toolbar */}
      <div className="toolbar flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">

          {/* Upload */}
          <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-lg border">
            <button onClick={() => fileInputRef.current.click()} className="icon-btn w-auto px-2 rounded-md">
              <div className="flex items-center gap-2 text-gray-700">
                <Upload size={18} /><span className="hidden sm:inline text-sm font-medium">Upload</span>
              </div>
            </button>
            <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleFileUpload} />
          </div>

          <div className="h-6 w-px bg-gray-300 mx-2" />

          {/* Tools */}
          <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border overflow-x-auto max-w-[50vw] sm:max-w-none no-scrollbar">
            <ToolButton active={activeTool === 'cursor'} onClick={() => setActiveTool('cursor')} icon={<MousePointer size={18} />} label="Select / Move" />
            <ToolButton active={activeTool === 'pen'} onClick={() => setActiveTool('pen')} icon={<Pen size={18} />} label="Pen" />
            <ToolButton active={activeTool === 'eraser'} onClick={() => setActiveTool('eraser')} icon={<Eraser size={18} />} label="Eraser" />
            <div className="w-px h-6 bg-gray-200 mx-1" />
            <ToolButton active={activeTool === 'line'} onClick={() => setActiveTool('line')} icon={<Minus size={18} />} label="Line" />
            <ToolButton active={activeTool === 'rect'} onClick={() => setActiveTool('rect')} icon={<Square size={18} />} label="Rectangle" />
            <ToolButton active={activeTool === 'circle'} onClick={() => setActiveTool('circle')} icon={<Circle size={18} />} label="Circle" />
            <ToolButton active={activeTool === 'text'} onClick={() => setActiveTool('text')} icon={<Type size={18} />} label="Text" />
          </div>

          <div className="h-6 w-px bg-gray-300 mx-2" />

          {/* Style Controls */}
          {activeTool !== 'eraser' && (
            <div className="flex items-center gap-3">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0 p-0 shadow-sm" title="Color" />

              {/* Fill Toggle (smart) */}
              <button
                onClick={toggleFill}
                className={`icon-btn ${isFilled ? 'icon-btn-active' : ''}`}
                title="Fill Shapes (Paint Bucket)"
              >
                <PaintBucket size={18} />
              </button>

              {/* Thickness */}
              <div className="flex flex-col w-28">
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={lineWidth}
                  onChange={(e) => setLineWidth(parseInt(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-[10px] text-gray-500 text-center">{lineWidth}px</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={undoLast} className="icon-btn" title="Undo last action"><RotateCcw size={18} /></button>
          <button onClick={() => { setAnnotations({ ...annotations, [pageNum]: [] }); setSelected({ page: null, index: -1 }); }} className="icon-btn text-red-500 hover:bg-red-50" title="Clear Page"><Trash2 size={18} /></button>
          <div className="h-6 w-px bg-gray-300 mx-2" />
          <button onClick={exportPDF} disabled={!pdfDoc} className="btn-primary disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed">
            <span className="inline-flex items-center gap-2"><Save size={18} /><span className="hidden sm:inline">Save PDF</span></span>
          </button>
        </div>
      </div>

      {/* Main Workspace */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-gray-200/60 relative p-8 flex justify-center no-scrollbar"
        onMouseDown={handleContainerMouseDown}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onContextMenu={handleContextMenu}
      >
        {!pdfDoc ? (
          <div className="flex flex-col items-center justify-center text-gray-400 h-full">
            <div className="bg-white p-8 rounded-2xl shadow-sm text-center max-w-md">
              <Upload size={48} className="mx-auto mb-4 text-blue-500 opacity-50" />
              <h3 className="text-xl font-semibold text-gray-700 mb-2">Upload a Document</h3>
              <p className="mb-6">Select a PDF file to start annotating.</p>
              <button onClick={() => fileInputRef.current.click()} className="btn-primary">Choose PDF</button>
            </div>
          </div>
        ) : (
          <div
            className="relative shadow-xl origin-top-left"
            style={{ width: 'fit-content', height: 'fit-content', cursor: isPanning.current ? 'grabbing' : activeTool === 'cursor' ? (dragging ? 'grabbing' : 'grab') : 'crosshair' }}
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
            {textInput && (
              <div className="absolute z-50" style={{ left: textInput.x * scale, top: (textInput.y * scale) - 4 }}>
                <input
                  autoFocus
                  value={textInput.text}
                  onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
                  onBlur={finalizeText}
                  onKeyDown={handleTextSubmit}
                  className="bg-transparent border border-blue-500 rounded px-1 py-0 outline-none text-blue-900 placeholder-blue-300 shadow-sm bg-white/50"
                  style={{ font: `${16 * scale}px sans-serif`, color, minWidth: '100px', lineHeight: 1 }}
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
            <button onClick={() => setScale(s => Math.max(0.25, s - 0.25))} className="icon-btn"><ZoomOut size={16} /></button>
            <span className="text-xs font-mono w-12 text-center">{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale(s => Math.min(4, s + 0.25))} className="icon-btn"><ZoomIn size={16} /></button>
          </div>

          <div className="flex items-center gap-4">
            <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum <= 1} className="icon-btn disabled:opacity-30"><ChevronLeft size={20} /></button>
            <span className="font-medium text-sm">Page {pageNum} of {pdfDoc.numPages}</span>
            <button onClick={() => setPageNum(p => Math.min(pdfDoc.numPages, p + 1))} disabled={pageNum >= pdfDoc.numPages} className="icon-btn disabled:opacity-30"><ChevronRight size={20} /></button>
          </div>

          <div className="text-xs text-gray-400 max-w-[200px] truncate">{fileName}</div>
        </div>
      )}
    </div>
  );
};

// Helper Component for Tools
const ToolButton = ({ active, onClick, icon, label }) => (
  <button onClick={onClick} className={`icon-btn ${active ? 'icon-btn-active' : ''}`} title={label}>
    {icon}
  </button>
);

export default App;
