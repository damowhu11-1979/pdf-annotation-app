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
  Sparkles,
  Loader2,
} from 'lucide-react';

// External libraries
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

// --- Gemini API Helper (only used for text polish button) ---
const callGemini = async (prompt, systemInstruction = "") => {
  const apiKey = ""; // Injected at runtime or pasted by user
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

const ToolButton = ({ active, onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    className={[
      "h-9 w-9 rounded-md grid place-items-center transition",
      "text-gray-600 hover:bg-gray-100",
      active ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200" : ""
    ].join(" ")}
  >
    {icon}
  </button>
);

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
  const [fontSize, setFontSize] = useState(16);
  const [isFilled, setIsFilled] = useState(false);

  // Annotations store: { pageNum: [ ... ] }
  const [annotations, setAnnotations] = useState({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState([]);
  const [startPoint, setStartPoint] = useState(null);

  // Text input overlay state
  const [textInput, setTextInput] = useState(null); // { x, y, text } in PDF coords
  const textInputRef = useRef(null);

  // AI State (polish)
  const [isPolishing, setIsPolishing] = useState(false);

  const canvasRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);

  // Panning State (global pointer listeners)
  const isPanning = useRef(false);
  const [isPanningState, setIsPanningState] = useState(false);
  const startPan = useRef({ x: 0, y: 0, sl: 0, st: 0 });

  // Moving annotations (cursor tool)
  const dragAnnRef = useRef({
    active: false,
    index: -1,
    start: { x: 0, y: 0 }, // PDF coords
    original: null,
  });

  const [selectedIndex, setSelectedIndex] = useState(-1);

  // ---------- Helpers ----------
  const deepCopyAnn = (ann) => JSON.parse(JSON.stringify(ann));

  const translateAnn = (ann, dx, dy) => {
    const a = deepCopyAnn(ann);
    if (a.type === 'pen' || a.type === 'eraser') {
      a.points = a.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    } else if (a.type === 'line' || a.type === 'arrow') {
      a.start = { x: a.start.x + dx, y: a.start.y + dy };
      a.end = { x: a.end.x + dx, y: a.end.y + dy };
    } else if (a.type === 'rect') {
      a.start = { x: a.start.x + dx, y: a.start.y + dy };
      a.end = { x: a.end.x + dx, y: a.end.y + dy };
    } else if (a.type === 'circle') {
      a.center = { x: a.center.x + dx, y: a.center.y + dy };
    } else if (a.type === 'text') {
      a.x = a.x + dx;
      a.y = a.y + dy;
    }
    return a;
  };

  const annBBoxPdf = (ann) => {
    if (ann.type === 'pen' || ann.type === 'eraser') {
      const xs = ann.points.map(p => p.x);
      const ys = ann.points.map(p => p.y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    if (ann.type === 'line' || ann.type === 'arrow') {
      return {
        minX: Math.min(ann.start.x, ann.end.x),
        maxX: Math.max(ann.start.x, ann.end.x),
        minY: Math.min(ann.start.y, ann.end.y),
        maxY: Math.max(ann.start.y, ann.end.y),
      };
    }
    if (ann.type === 'rect') {
      return {
        minX: Math.min(ann.start.x, ann.end.x),
        maxX: Math.max(ann.start.x, ann.end.x),
        minY: Math.min(ann.start.y, ann.end.y),
        maxY: Math.max(ann.start.y, ann.end.y),
      };
    }
    if (ann.type === 'circle') {
      return {
        minX: ann.center.x - ann.radius,
        maxX: ann.center.x + ann.radius,
        minY: ann.center.y - ann.radius,
        maxY: ann.center.y + ann.radius,
      };
    }
    if (ann.type === 'text') {
      const w = Math.max(10, (ann.text?.length || 1) * (ann.size * 0.6));
      const h = ann.size * 1.2;
      return { minX: ann.x, maxX: ann.x + w, minY: ann.y, maxY: ann.y + h };
    }
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  };

  const hitTestPage = (ptPdf) => {
    const pageAnns = annotations[pageNum] || [];
    const tol = 10 / scale;
    for (let i = pageAnns.length - 1; i >= 0; i--) {
      const bb = annBBoxPdf(pageAnns[i]);
      if (
        ptPdf.x >= bb.minX - tol &&
        ptPdf.x <= bb.maxX + tol &&
        ptPdf.y >= bb.minY - tol &&
        ptPdf.y <= bb.maxY + tol
      ) {
        return i;
      }
    }
    return -1;
  };

  const getPdfCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;

    return { x: canvasX / scale, y: canvasY / scale };
  };

  // ---------- Load libs ----------
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

  // ---------- Upload ----------
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
        setSelectedIndex(-1);
      } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error parsing PDF. Please try another file.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // ---------- Render ----------
  useEffect(() => {
    if (!pdfDoc) return;
    renderPage(pageNum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNum, scale, pdfLib]);

  useEffect(() => {
    drawAnnotations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, pageNum, scale, currentPath, startPoint, isFilled, isDrawing, selectedIndex]);

  useEffect(() => {
    if (textInput && textInputRef.current) {
      setTimeout(() => textInputRef.current?.focus(), 10);
    }
  }, [textInput]);

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

  // Global panning listeners (makes right-click pan reliable)
  useEffect(() => {
    const handleGlobalPointerMove = (e) => {
      if (!isPanning.current || !scrollContainerRef.current) return;
      e.preventDefault();

      const dx = e.clientX - startPan.current.x;
      const dy = e.clientY - startPan.current.y;

      scrollContainerRef.current.scrollLeft = startPan.current.sl - dx;
      scrollContainerRef.current.scrollTop = startPan.current.st - dy;
    };

    const stopPan = () => {
      if (!isPanning.current) return;
      isPanning.current = false;
      setIsPanningState(false);
      document.body.style.cursor = 'default';
    };

    window.addEventListener('pointermove', handleGlobalPointerMove, { passive: false });
    window.addEventListener('pointerup', stopPan);
    window.addEventListener('pointercancel', stopPan);

    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', stopPan);
      window.removeEventListener('pointercancel', stopPan);
    };
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

  // ---------- Pan start ----------
  const handleContainerPointerDown = (e) => {
    const isPanButton =
      e.button === 2 ||                // right
      e.button === 1 ||                // middle
      (e.button === 0 && activeTool === 'cursor'); // left on cursor tool

    if (!isPanButton) return;

    e.preventDefault();

    const el = scrollContainerRef.current;
    if (!el) return;

    isPanning.current = true;
    setIsPanningState(true);
    document.body.style.cursor = 'grabbing';

    startPan.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop
    };
  };

  // ---------- AI polish ----------
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

  // ---------- Text finalize ----------
  const finalizeText = (shouldClose = true) => {
    if (!textInput) return;
    const t = (textInput.text || '').trim();

    if (t) {
      const newAnn = {
        type: 'text',
        x: textInput.x,
        y: textInput.y,
        text: textInput.text,
        color,
        size: fontSize
      };

      setAnnotations(prev => ({
        ...prev,
        [pageNum]: [...(prev[pageNum] || []), newAnn]
      }));
    }

    if (shouldClose) setTextInput(null);
  };

  const handleInputBlur = () => finalizeText(true);

  const handleTextSubmit = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finalizeText(true);
    }
  };

  // ---------- Arrow drawing helper ----------
  const strokeArrow = (ctx, x1, y1, x2, y2, headLenPx) => {
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

  // ---------- Canvas interactions ----------
  const handleCanvasPointerDown = (e) => {
    // allow right-click pan to bubble to container, but suppress context menu behavior
    if (e.button === 2) {
      e.preventDefault();
      return; // do not draw on right click
    }

    // only left click for editing/drawing
    if (e.button !== 0) return;

    if (activeTool === 'cursor') {
      const pt = getPdfCoordinates(e);
      const idx = hitTestPage(pt);
      setSelectedIndex(idx);

      if (idx !== -1) {
        // stop pan start when dragging object
        e.preventDefault();
        e.stopPropagation();

        dragAnnRef.current.active = true;
        dragAnnRef.current.index = idx;
        dragAnnRef.current.start = pt;

        const pageAnns = annotations[pageNum] || [];
        dragAnnRef.current.original = deepCopyAnn(pageAnns[idx]);

        try { canvasRef.current?.setPointerCapture(e.pointerId); } catch {}
      }
      return;
    }

    const coords = getPdfCoordinates(e);

    if (activeTool === 'text') {
      e.preventDefault();
      if (textInput) finalizeText(false);
      setTextInput({ x: coords.x, y: coords.y, text: '' });
      return;
    }

    setIsDrawing(true);
    setStartPoint(coords);

    if (activeTool === 'pen' || activeTool === 'eraser') {
      setCurrentPath([coords]);
    }

    try { canvasRef.current?.setPointerCapture(e.pointerId); } catch {}
  };

  const handleCanvasPointerMove = (e) => {
    if (dragAnnRef.current.active) {
      e.preventDefault();
      e.stopPropagation();

      const pt = getPdfCoordinates(e);
      const { start, index, original } = dragAnnRef.current;
      const dx = pt.x - start.x;
      const dy = pt.y - start.y;

      const moved = translateAnn(original, dx, dy);

      setAnnotations(prev => {
        const pageAnns = [...(prev[pageNum] || [])];
        if (index < 0 || index >= pageAnns.length) return prev;
        pageAnns[index] = moved;
        return { ...prev, [pageNum]: pageAnns };
      });
      return;
    }

    if (!isDrawing) return;

    const coords = getPdfCoordinates(e);

    if (activeTool === 'pen' || activeTool === 'eraser') {
      setCurrentPath(prev => [...prev, coords]);
    } else if (['line', 'arrow', 'rect', 'circle'].includes(activeTool)) {
      canvasRef.current.tempEnd = coords;
      drawAnnotations();
    }
  };

  const handleCanvasPointerUp = (e) => {
    if (dragAnnRef.current.active) {
      e.preventDefault();
      e.stopPropagation();
      dragAnnRef.current.active = false;
      dragAnnRef.current.index = -1;
      dragAnnRef.current.original = null;
      try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    if (!isDrawing) {
      try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

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
      setSelectedIndex(-1);
    }

    setIsDrawing(false);
    setCurrentPath([]);
    setStartPoint(null);
    if (canvasRef.current) canvasRef.current.tempEnd = null;

    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch {}
  };

  // ---------- Draw ----------
  const drawAnnotations = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawItem = (ann, idx) => {
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

      // selection highlight
      if (idx === selectedIndex && activeTool === 'cursor') {
        const bb = annBBoxPdf(ann);
        const pad = 6;
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(37,99,235,0.9)';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(
          bb.minX * scale - pad,
          bb.minY * scale - pad,
          (bb.maxX - bb.minX) * scale + pad * 2,
          (bb.maxY - bb.minY) * scale + pad * 2
        );
        ctx.setLineDash([]);
      }

      ctx.restore();
    };

    const pageAnns = annotations[pageNum] || [];
    pageAnns.forEach((ann, idx) => drawItem(ann, idx));

    // preview
    if (isDrawing) {
      const tempEnd = canvas.tempEnd;
      if (activeTool === 'pen' || activeTool === 'eraser') {
        drawItem({
          type: activeTool,
          points: currentPath,
          color: activeTool === 'eraser' ? '#ffffff' : color,
          width: activeTool === 'eraser' ? 20 : lineWidth
        }, -999);
      } else if (startPoint && tempEnd) {
        if (activeTool === 'line') {
          drawItem({ type: 'line', start: startPoint, end: tempEnd, color, width: lineWidth }, -999);
        } else if (activeTool === 'arrow') {
          drawItem({ type: 'arrow', start: startPoint, end: tempEnd, color, width: lineWidth }, -999);
        } else if (activeTool === 'rect') {
          drawItem({ type: 'rect', start: startPoint, end: tempEnd, color, width: lineWidth, filled: isFilled }, -999);
        } else if (activeTool === 'circle') {
          const r = Math.sqrt(Math.pow(tempEnd.x - startPoint.x, 2) + Math.pow(tempEnd.y - startPoint.y, 2));
          drawItem({ type: 'circle', center: startPoint, radius: r, color, width: lineWidth, filled: isFilled }, -999);
        }
      }
    }
  };

  // ---------- Actions ----------
  const undoLast = () => {
    const pageAnns = annotations[pageNum] || [];
    if (pageAnns.length === 0) return;
    setAnnotations(prev => ({ ...prev, [pageNum]: pageAnns.slice(0, -1) }));
    setSelectedIndex(-1);
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
      {/* Toolbar (styled like your screenshot) */}
      <div className="bg-white border-b shadow-sm px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => fileInputRef.current.click()}
            className="h-9 px-4 rounded-lg border bg-white hover:bg-gray-50 text-gray-700 flex items-center gap-2 text-sm font-medium shadow-sm"
          >
            <Upload size={16} />
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={handleFileUpload}
          />

          <div className="flex items-center gap-1 rounded-xl border bg-white p-1 shadow-sm">
            <ToolButton active={activeTool === "cursor"} onClick={() => setActiveTool("cursor")} icon={<MousePointer size={18} />} label="Select / Move / Pan" />
            <ToolButton active={activeTool === "pen"} onClick={() => setActiveTool("pen")} icon={<Pen size={18} />} label="Pen" />
            <ToolButton active={activeTool === "eraser"} onClick={() => setActiveTool("eraser")} icon={<Eraser size={18} />} label="Eraser" />

            <div className="w-px h-6 bg-gray-200 mx-1" />

            <ToolButton active={activeTool === "line"} onClick={() => setActiveTool("line")} icon={<Minus size={18} />} label="Line" />
            <ToolButton active={activeTool === "arrow"} onClick={() => setActiveTool("arrow")} icon={<ArrowRight size={18} />} label="Arrow" />
            <ToolButton active={activeTool === "rect"} onClick={() => setActiveTool("rect")} icon={<Square size={18} />} label="Rectangle" />
            <ToolButton active={activeTool === "circle"} onClick={() => setActiveTool("circle")} icon={<Circle size={18} />} label="Circle" />
            <ToolButton active={activeTool === "text"} onClick={() => setActiveTool("text")} icon={<Type size={18} />} label="Text" />
          </div>

          <div className="flex items-center gap-3 rounded-xl border bg-white px-3 py-1 shadow-sm">
            <label className="h-7 w-7 rounded-md border shadow-sm overflow-hidden cursor-pointer">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-10 w-10 -m-1 cursor-pointer"
                title="Color"
              />
            </label>

            {activeTool === 'text' ? (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="8"
                  max="72"
                  value={fontSize}
                  onChange={(e) => setFontSize(parseInt(e.target.value))}
                  className="w-36 accent-blue-600"
                  title="Font size"
                />
                <span className="text-xs text-gray-500 w-10 text-right">{fontSize}px</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={lineWidth}
                  onChange={(e) => setLineWidth(parseInt(e.target.value))}
                  className="w-36 accent-blue-600"
                  title="Thickness"
                />
                <span className="text-xs text-gray-500 w-10 text-right">{lineWidth}px</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsFilled(!isFilled)}
              className={[
                "h-9 w-9 rounded-md grid place-items-center transition",
                isFilled ? "bg-blue-600 text-white" : "text-gray-500 hover:bg-gray-100"
              ].join(" ")}
              title="Fill shapes"
            >
              <PaintBucket size={18} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={undoLast}
            className="h-9 w-9 rounded-md grid place-items-center text-gray-600 hover:bg-gray-100"
            title="Undo"
          >
            <RotateCcw size={18} />
          </button>

          <button
            type="button"
            onClick={() => { setAnnotations(prev => ({ ...prev, [pageNum]: [] })); setSelectedIndex(-1); }}
            className="h-9 w-9 rounded-md grid place-items-center text-red-500 hover:bg-red-50"
            title="Clear Page"
          >
            <Trash2 size={18} />
          </button>

          <button
            type="button"
            onClick={exportPDF}
            disabled={!pdfDoc}
            className={[
              "h-9 px-4 rounded-lg font-medium flex items-center gap-2 shadow-sm",
              pdfDoc ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-gray-200 text-gray-400 cursor-not-allowed"
            ].join(" ")}
          >
            <Save size={18} />
            Save PDF
          </button>
        </div>
      </div>

      {/* Main Workspace */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-gray-200 relative"
        style={{ userSelect: 'none', touchAction: 'none' }}
        onPointerDown={handleContainerPointerDown}
        onContextMenu={(e) => e.preventDefault()}
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
              <canvas
                ref={pdfCanvasRef}
                className="bg-white block"
                onContextMenu={(e) => e.preventDefault()}
              />

              <canvas
                ref={canvasRef}
                className="absolute top-0 left-0"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                onPointerLeave={handleCanvasPointerUp}
                onContextMenu={(e) => e.preventDefault()}
              />

              {/* Text input overlay */}
              {textInput && (
                <div
                  className="absolute z-50 flex items-center gap-2"
                  style={{
                    left: textInput.x * scale,
                    top: (textInput.y * scale) - 8
                  }}
                >
                  <input
                    ref={textInputRef}
                    value={textInput.text}
                    onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
                    onBlur={handleInputBlur}
                    onKeyDown={handleTextSubmit}
                    className="bg-white border border-blue-500 rounded px-2 py-1 outline-none shadow-lg min-w-[220px]"
                    style={{
                      fontSize: `${fontSize * scale}px`,
                      fontFamily: 'sans-serif',
                      color: color,
                      lineHeight: 1.2
                    }}
                    placeholder="Type… (Enter to save)"
                    onPointerDown={(e) => e.stopPropagation()}
                  />

                  <button
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent blur
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
          </div>
        )}
      </div>

      {/* Footer (optional, clean like your screenshot) */}
      {pdfDoc && (
        <div className="bg-white border-t px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setScale(s => Math.max(0.25, s - 0.25))} className="h-9 w-9 rounded-md grid place-items-center hover:bg-gray-100">
              <ZoomOut size={16} />
            </button>
            <span className="text-xs font-mono w-14 text-center text-gray-600">{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale(s => Math.min(4, s + 0.25))} className="h-9 w-9 rounded-md grid place-items-center hover:bg-gray-100">
              <ZoomIn size={16} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPageNum(p => Math.max(1, p - 1))}
              disabled={pageNum <= 1}
              className="h-9 w-9 rounded-md grid place-items-center hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm text-gray-700">
              Page {pageNum} of {pdfDoc.numPages}
            </span>
            <button
              onClick={() => setPageNum(p => Math.min(pdfDoc.numPages, p + 1))}
              disabled={pageNum >= pdfDoc.numPages}
              className="h-9 w-9 rounded-md grid place-items-center hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="text-xs text-gray-400 max-w-[220px] truncate">{fileName}</div>
        </div>
      )}
    </div>
  );
};

export default App;
