import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Upload,
  Pen,
  Minus,
  Type,
  ArrowRight,
  RotateCcw,
  Trash2,
  Save,
  MousePointer,
  Square,
  Circle,
  Eraser,
  PaintBucket,
  Sparkles,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

// External libraries via CDN
const PDFJS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

// --- Gemini API Helper (optional) ---
const callGemini = async (prompt, systemInstruction = "") => {
  const apiKey = ""; // Injected at runtime
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: systemInstruction
      ? { parts: [{ text: systemInstruction }] }
      : undefined,
  };

  let delay = 1000;
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 429) throw new Error("Too Many Requests");
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      return (
        data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated."
      );
    } catch (error) {
      if (i === 4) throw error;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
};

const App = () => {
  const [pdfLib, setPdfLib] = useState(null);
  const [jspdfLib, setJspdfLib] = useState(null);

  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2); // Good default starting scale
  const [fileName, setFileName] = useState("document.pdf");

  // Tools: 'cursor', 'pen', 'line', 'arrow', 'rect', 'circle', 'text', 'eraser'
  const [activeTool, setActiveTool] = useState("cursor");
  const [color, setColor] = useState("#EF4444");
  const [lineWidth, setLineWidth] = useState(3);
  const [fontSize, setFontSize] = useState(16);
  const [isFilled, setIsFilled] = useState(false);

  // Annotations store: { pageNum: [ ... ] }
  const [annotations, setAnnotations] = useState({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState([]);
  const [startPoint, setStartPoint] = useState(null);

  // Text overlay input
  const [textInput, setTextInput] = useState(null); // { x, y, text }
  const textInputRef = useRef(null);

  // AI state
  const [isPolishing, setIsPolishing] = useState(false);

  // Refs
  const canvasRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);

  // Queue for file upload if libraries aren't ready
  const pendingFileRef = useRef(null);
  const [pdfEngineReady, setPdfEngineReady] = useState(false);

  // Panning
  const isPanning = useRef(false);
  const [isPanningState, setIsPanningState] = useState(false);
  const startPan = useRef({ x: 0, y: 0, sl: 0, st: 0 });
  const panPointerIdRef = useRef(null);

  // Spacebar pan
  const spaceDownRef = useRef(false);
  useEffect(() => {
    const down = (e) => {
      if (e.code === "Space") {
        if (document.activeElement === document.body) e.preventDefault();
        spaceDownRef.current = true;
        // If we are in cursor mode or just holding space, update cursor
        document.body.style.cursor = "grab";
      }
    };
    const up = (e) => {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        document.body.style.cursor = "default";
      }
    };
    window.addEventListener("keydown", down, { passive: false });
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Moving annotations (cursor tool)
  const dragAnnRef = useRef({
    active: false,
    index: -1,
    start: { x: 0, y: 0 },
    original: null,
  });

  const [selectedIndex, setSelectedIndex] = useState(-1);

  // --------- Helpers ----------
  const deepCopyAnn = (ann) => JSON.parse(JSON.stringify(ann));

  const translateAnn = (ann, dx, dy) => {
    const a = deepCopyAnn(ann);
    if (a.type === "pen" || a.type === "eraser") {
      a.points = a.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (a.type === "line" || a.type === "arrow") {
      a.start = { x: a.start.x + dx, y: a.start.y + dy };
      a.end = { x: a.end.x + dx, y: a.end.y + dy };
    } else if (a.type === "rect") {
      a.start = { x: a.start.x + dx, y: a.start.y + dy };
      a.end = { x: a.end.x + dx, y: a.end.y + dy };
    } else if (a.type === "circle") {
      a.center = { x: a.center.x + dx, y: a.center.y + dy };
    } else if (a.type === "text") {
      a.x += dx;
      a.y += dy;
    }
    return a;
  };

  const annBBoxPdf = (ann) => {
    if (ann.type === "pen" || ann.type === "eraser") {
      const xs = ann.points.map((p) => p.x);
      const ys = ann.points.map((p) => p.y);
      return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      };
    }
    if (ann.type === "line" || ann.type === "arrow") {
      return {
        minX: Math.min(ann.start.x, ann.end.x),
        maxX: Math.max(ann.start.x, ann.end.x),
        minY: Math.min(ann.start.y, ann.end.y),
        maxY: Math.max(ann.start.y, ann.end.y),
      };
    }
    if (ann.type === "rect") {
      return {
        minX: Math.min(ann.start.x, ann.end.x),
        maxX: Math.max(ann.start.x, ann.end.x),
        minY: Math.min(ann.start.y, ann.end.y),
        maxY: Math.max(ann.start.y, ann.end.y),
      };
    }
    if (ann.type === "circle") {
      return {
        minX: ann.center.x - ann.radius,
        maxX: ann.center.x + ann.radius,
        minY: ann.center.y - ann.radius,
        maxY: ann.center.y + ann.radius,
      };
    }
    if (ann.type === "text") {
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

  // Load Libraries
  useEffect(() => {
    const loadLibs = async () => {
      try {
        if (!window.pdfjsLib) {
          const s1 = document.createElement("script");
          s1.src = PDFJS_URL;
          s1.onload = () => {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            setPdfLib(window.pdfjsLib);
            setPdfEngineReady(true);
          };
          s1.onerror = () => {
            console.error("Failed to load pdf.js");
            setPdfEngineReady(false);
          };
          document.head.appendChild(s1);
        } else {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
          setPdfLib(window.pdfjsLib);
          setPdfEngineReady(true);
        }

        if (!window.jspdf) {
          const s2 = document.createElement("script");
          s2.src = JSPDF_URL;
          s2.onload = () => setJspdfLib(window.jspdf);
          s2.onerror = () => console.error("Failed to load jspdf");
          document.head.appendChild(s2);
        } else {
          setJspdfLib(window.jspdf);
        }
      } catch (e) {
        console.error("Failed to load libraries", e);
      }
    };
    loadLibs();
  }, []);

  // Process pending file if it was uploaded before PDF engine was ready
  useEffect(() => {
    if (pdfLib && pendingFileRef.current) {
      const f = pendingFileRef.current;
      pendingFileRef.current = null;
      processFile(f);
    }
  }, [pdfLib]);

  const processFile = useCallback(
    async (file) => {
      if (!file || !pdfLib) return;

      setFileName(file.name);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const typedarray = new Uint8Array(arrayBuffer);

        const loadingTask = pdfLib.getDocument(typedarray);
        const pdf = await loadingTask.promise;

        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);
        setPageNum(1);
        setAnnotations({});
        setTextInput(null);
        setSelectedIndex(-1);
      } catch (error) {
        console.error("Error loading PDF:", error);
        alert("Error parsing PDF. Please try another file.");
      }
    },
    [pdfLib]
  );

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!pdfLib) {
      pendingFileRef.current = file;
      alert("PDF engine is initializing... the file will load momentarily.");
      return;
    }

    await processFile(file);
  };

  // Render Page
  useEffect(() => {
    if (!pdfDoc) return;
    renderPage(pageNum);
  }, [pdfDoc, pageNum, scale, pdfLib]);

  // Redraw annotations
  useEffect(() => {
    drawAnnotations();
  }, [
    annotations,
    pageNum,
    scale,
    currentPath,
    startPoint,
    isFilled,
    isDrawing,
    selectedIndex,
    fontSize,
    activeTool
  ]);

  // Focus text input
  useEffect(() => {
    if (textInput && textInputRef.current) {
      setTimeout(() => textInputRef.current?.focus(), 10);
    }
  }, [textInput]);

  // Handle Wheel: Ctrl+Wheel for Zoom, Normal Wheel for scrolling (native)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = -e.deltaY;
        const zoomStep = 0.1;
        setScale((prev) => {
          const next = delta > 0 ? prev + zoomStep : prev - zoomStep;
          return Math.min(5, Math.max(0.25, next));
        });
      }
      // If no Ctrl key, let standard scrolling happen
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  const renderPage = async (num) => {
    if (!pdfDoc) return;

    renderRequestRef.current++;
    const requestId = renderRequestRef.current;

    if (renderTaskRef.current) {
      try {
        await renderTaskRef.current.cancel();
      } catch (_) {}
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
          canvasContext: pdfCanvas.getContext("2d"),
          viewport,
        };

        const task = page.render(renderContext);
        renderTaskRef.current = task;

        await task.promise;

        if (renderRequestRef.current === requestId) {
          renderTaskRef.current = null;
          drawAnnotations();
        }
      }
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return;
      console.error("Error rendering page:", error);
    }
  };

  // --- PANNING LOGIC ---
  useEffect(() => {
    const onMove = (e) => {
      if (!isPanning.current) return;
      if (panPointerIdRef.current != null && e.pointerId !== panPointerIdRef.current)
        return;

      e.preventDefault();
      const el = scrollContainerRef.current;
      if (!el) return;

      const dx = e.clientX - startPan.current.x;
      const dy = e.clientY - startPan.current.y;

      el.scrollLeft = startPan.current.sl - dx;
      el.scrollTop = startPan.current.st - dy;
    };

    const end = (e) => {
      if (!isPanning.current) return;
      if (panPointerIdRef.current != null && e.pointerId !== panPointerIdRef.current)
        return;

      isPanning.current = false;
      panPointerIdRef.current = null;
      setIsPanningState(false);
      document.body.style.cursor = "default";
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const handleContainerPointerDown = (e) => {
    // Panning Allowed: Middle/Right Click OR Left Click + (Cursor Tool or Spacebar)
    const isPanButton =
      e.button === 1 ||
      e.button === 2 ||
      (e.button === 0 && (activeTool === "cursor" || spaceDownRef.current));

    if (!isPanButton) return;

    e.preventDefault();
    const el = scrollContainerRef.current;
    if (!el) return;

    isPanning.current = true;
    panPointerIdRef.current = e.pointerId;
    setIsPanningState(true);
    document.body.style.cursor = "grabbing";

    startPan.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
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

  // --- Text Operations ---
  const handlePolishText = async () => {
    if (!textInput || !textInput.text.trim()) return;
    setIsPolishing(true);
    try {
      const prompt = `Rewrite the following text to be more professional, grammatically correct, and concise: "${textInput.text}". Return ONLY the rewritten text, no explanations.`;
      const polishedText = await callGemini(prompt, "You are a professional editor.");
      setTextInput((prev) => ({ ...prev, text: polishedText.trim() }));
    } catch (err) {
      console.error("Polishing failed", err);
    } finally {
      setIsPolishing(false);
    }
  };

  const finalizeText = (shouldClose = true) => {
    if (!textInput) return;
    const t = (textInput.text || "").trim();
    if (t) {
      const newAnn = {
        type: "text",
        x: textInput.x,
        y: textInput.y,
        text: textInput.text,
        color,
        size: fontSize,
      };
      setAnnotations((prev) => ({
        ...prev,
        [pageNum]: [...(prev[pageNum] || []), newAnn],
      }));
    }
    if (shouldClose) setTextInput(null);
  };

  const handleInputBlur = () => finalizeText(true);
  const handleTextSubmit = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finalizeText(true);
    }
  };

  // --- Drawing Helpers ---
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

  // --- Canvas Pointers ---
  const handleCanvasPointerDown = (e) => {
    if (e.button === 2) { // Allow right-click pan
      e.preventDefault();
      return; 
    }
    if (spaceDownRef.current) return; // Allow space-pan
    if (e.button !== 0) return; // Only left click draws/selects

    if (activeTool === "cursor") {
      const pt = getPdfCoordinates(e);
      const idx = hitTestPage(pt);
      setSelectedIndex(idx);

      if (idx !== -1) {
        e.preventDefault();
        e.stopPropagation();

        dragAnnRef.current.active = true;
        dragAnnRef.current.index = idx;
        dragAnnRef.current.start = pt;
        dragAnnRef.current.original = deepCopyAnn((annotations[pageNum] || [])[idx]);

        try { canvasRef.current?.setPointerCapture(e.pointerId); } catch {}
      }
      return;
    }

    const coords = getPdfCoordinates(e);

    if (activeTool === "text") {
      e.preventDefault();
      if (textInput) finalizeText(false);
      setTextInput({ x: coords.x, y: coords.y, text: "" });
      return;
    }

    setIsDrawing(true);
    setStartPoint(coords);

    if (activeTool === "pen" || activeTool === "eraser") {
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
      setAnnotations((prev) => {
        const pageAnns = [...(prev[pageNum] || [])];
        if (index < 0 || index >= pageAnns.length) return prev;
        pageAnns[index] = moved;
        return { ...prev, [pageNum]: pageAnns };
      });
      return;
    }

    if (!isDrawing) return;
    const coords = getPdfCoordinates(e);

    if (activeTool === "pen" || activeTool === "eraser") {
      setCurrentPath((prev) => [...prev, coords]);
    } else if (["line", "arrow", "rect", "circle"].includes(activeTool)) {
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
      color: activeTool === "eraser" ? "#ffffff" : color,
      width: activeTool === "eraser" ? 20 : lineWidth,
    };

    if (activeTool === "pen" || activeTool === "eraser") {
      newAnn = { ...baseProps, type: activeTool, points: currentPath };
    } else if (activeTool === "line") {
      newAnn = { ...baseProps, type: "line", start: startPoint, end: coords };
    } else if (activeTool === "arrow") {
      newAnn = { ...baseProps, type: "arrow", start: startPoint, end: coords };
    } else if (activeTool === "rect") {
      newAnn = { ...baseProps, type: "rect", start: startPoint, end: coords, filled: isFilled };
    } else if (activeTool === "circle") {
      const radius = Math.sqrt(Math.pow(coords.x - startPoint.x, 2) + Math.pow(coords.y - startPoint.y, 2));
      newAnn = { ...baseProps, type: "circle", center: startPoint, radius, filled: isFilled };
    }

    if (newAnn) {
      setAnnotations((prev) => ({
        ...prev,
        [pageNum]: [...(prev[pageNum] || []), newAnn],
      }));
      setSelectedIndex(-1);
    }

    setIsDrawing(false);
    setCurrentPath([]);
    setStartPoint(null);
    if (canvasRef.current) canvasRef.current.tempEnd = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch {}
  };

  // --- Rendering Annotations ---
  const drawAnnotations = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawItem = (ann, idx) => {
      ctx.save();
      if (ann.type === "eraser") ctx.globalCompositeOperation = "destination-out";
      else ctx.globalCompositeOperation = "source-over";

      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.width * scale;
      ctx.fillStyle = ann.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (ann.type === "pen" || ann.type === "eraser") {
        ctx.beginPath();
        if (ann.points.length > 0) {
          ctx.moveTo(ann.points[0].x * scale, ann.points[0].y * scale);
          ann.points.forEach((p) => ctx.lineTo(p.x * scale, p.y * scale));
        }
        ctx.stroke();
      } else if (ann.type === "line") {
        ctx.beginPath();
        ctx.moveTo(ann.start.x * scale, ann.start.y * scale);
        ctx.lineTo(ann.end.x * scale, ann.end.y * scale);
        ctx.stroke();
      } else if (ann.type === "arrow") {
        const x1 = ann.start.x * scale;
        const y1 = ann.start.y * scale;
        const x2 = ann.end.x * scale;
        const y2 = ann.end.y * scale;
        const head = Math.max(10, ann.width * 3) * scale;
        strokeArrow(ctx, x1, y1, x2, y2, head);
      } else if (ann.type === "rect") {
        const x = ann.start.x * scale;
        const y = ann.start.y * scale;
        const w = (ann.end.x - ann.start.x) * scale;
        const h = (ann.end.y - ann.start.y) * scale;
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        if (ann.filled) ctx.fill();
        ctx.stroke();
      } else if (ann.type === "circle") {
        ctx.beginPath();
        ctx.arc(ann.center.x * scale, ann.center.y * scale, ann.radius * scale, 0, 2 * Math.PI);
        if (ann.filled) ctx.fill();
        ctx.stroke();
      } else if (ann.type === "text") {
        ctx.font = `${ann.size * scale}px sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillStyle = ann.color;
        ctx.fillText(ann.text, ann.x * scale, ann.y * scale);
      }

      // Selection Highlight
      if (idx === selectedIndex && activeTool === "cursor") {
        const bb = annBBoxPdf(ann);
        const pad = 6;
        ctx.globalCompositeOperation = "source-over";
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(37,99,235,0.9)";
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

    // Preview
    if (isDrawing) {
      const tempEnd = canvas.tempEnd;
      if (activeTool === "pen" || activeTool === "eraser") {
        drawItem({ type: activeTool, points: currentPath, color: activeTool === "eraser" ? "#ffffff" : color, width: activeTool === "eraser" ? 20 : lineWidth }, -999);
      } else if (startPoint && tempEnd) {
        if (activeTool === "line") drawItem({ type: "line", start: startPoint, end: tempEnd, color, width: lineWidth }, -999);
        else if (activeTool === "arrow") drawItem({ type: "arrow", start: startPoint, end: tempEnd, color, width: lineWidth }, -999);
        else if (activeTool === "rect") drawItem({ type: "rect", start: startPoint, end: tempEnd, color, width: lineWidth, filled: isFilled }, -999);
        else if (activeTool === "circle") {
          const r = Math.sqrt(Math.pow(tempEnd.x - startPoint.x, 2) + Math.pow(tempEnd.y - startPoint.y, 2));
          drawItem({ type: "circle", center: startPoint, radius: r, color, width: lineWidth, filled: isFilled }, -999);
        }
      }
    }
  };

  const undoLast = () => {
    const pageAnns = annotations[pageNum] || [];
    if (pageAnns.length === 0) return;
    setAnnotations((prev) => ({ ...prev, [pageNum]: pageAnns.slice(0, -1) }));
    setSelectedIndex(-1);
  };

  const changePage = (delta) => {
    const next = pageNum + delta;
    if (next >= 1 && next <= totalPages) {
      setPageNum(next);
      setSelectedIndex(-1);
      setTextInput(null);
    }
  };

  const exportPDF = async () => {
    if (!pdfDoc || !jspdfLib) return;
    const { jsPDF } = jspdfLib;

    const doc = new jsPDF({
      orientation: "p",
      unit: "pt",
      format: "a4",
      putOnlyUsedFonts: true,
    });

    doc.deletePage(1);
    const exportScale = 2.0;

    const strokeArrowExport = (ctx, x1, y1, x2, y2, headLenPx) => {
       ctx.beginPath();
       ctx.moveTo(x1, y1);
       ctx.lineTo(x2, y2);
       ctx.stroke();
       const angle = Math.atan2(y2 - y1, x2 - x1);
       const hx1 = x2 - headLenPx * Math.cos(angle - Math.PI / 7);
       const hy1 = y2 - headLenPx * Math.sin(angle - Math.PI / 7);
       const hx2 = x2 - headLenPx * Math.cos(angle + Math.PI / 7);
       const hy2 = y2 - headLenPx * Math.sin(angle + Math.PI / 7);
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
        originalViewport.width > originalViewport.height ? "l" : "p"
      );

      const viewport = page.getViewport({ scale: exportScale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");

      await page.render({ canvasContext: ctx, viewport }).promise;

      const pageAnns = annotations[i] || [];
      pageAnns.forEach((ann) => {
        ctx.save();
        if (ann.type === "eraser") ctx.globalCompositeOperation = "destination-out";
        else ctx.globalCompositeOperation = "source-over";

        ctx.strokeStyle = ann.color;
        ctx.lineWidth = ann.width * exportScale;
        ctx.fillStyle = ann.color;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const s = exportScale;

        if (ann.type === "pen" || ann.type === "eraser") {
          ctx.beginPath();
          if (ann.points.length > 0) {
            ctx.moveTo(ann.points[0].x * s, ann.points[0].y * s);
            ann.points.forEach((p) => ctx.lineTo(p.x * s, p.y * s));
          }
          ctx.stroke();
        } else if (ann.type === "line") {
          ctx.beginPath();
          ctx.moveTo(ann.start.x * s, ann.start.y * s);
          ctx.lineTo(ann.end.x * s, ann.end.y * s);
          ctx.stroke();
        } else if (ann.type === "arrow") {
          const head = Math.max(10, ann.width * 3) * s;
          strokeArrowExport(ctx, ann.start.x * s, ann.start.y * s, ann.end.x * s, ann.end.y * s, head);
        } else if (ann.type === "rect") {
          ctx.beginPath();
          ctx.rect(ann.start.x * s, ann.start.y * s, (ann.end.x - ann.start.x) * s, (ann.end.y - ann.start.y) * s);
          if (ann.filled) ctx.fill();
          ctx.stroke();
        } else if (ann.type === "circle") {
          ctx.beginPath();
          ctx.arc(ann.center.x * s, ann.center.y * s, ann.radius * s, 0, 2 * Math.PI);
          if (ann.filled) ctx.fill();
          ctx.stroke();
        } else if (ann.type === "text") {
          ctx.font = `${ann.size * s}px sans-serif`;
          ctx.textBaseline = "top";
          ctx.fillStyle = ann.color;
          ctx.fillText(ann.text, ann.x * s, ann.y * s);
        }
        ctx.restore();
      });

      const imgData = canvas.toDataURL("image/jpeg", 0.95);
      doc.addImage(imgData, "JPEG", 0, 0, originalViewport.width, originalViewport.height);
    }

    doc.save(`edited_${fileName}`);
  };

  const uploadDisabled = !pdfEngineReady;

  return (
    <div className="flex flex-col h-screen bg-gray-100 font-sans text-gray-800">
      {/* Header / Toolbar */}
      <div className="bg-white border-b shadow-sm p-4 flex flex-wrap items-center justify-between gap-3 z-10 shrink-0">
        <div className="flex items-center gap-3 overflow-x-auto no-scrollbar max-w-[60vw] md:max-w-none">
          {/* File Upload */}
          <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-lg border shrink-0">
            <label
              htmlFor="pdf-upload"
              className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-colors ${
                uploadDisabled
                  ? "text-gray-400 cursor-not-allowed"
                  : "text-gray-700 hover:bg-gray-200 cursor-pointer"
              }`}
            >
              <Upload size={18} />
              <span className="hidden sm:inline">
                {uploadDisabled ? "Init..." : "Open"}
              </span>
            </label>
            <input
              id="pdf-upload"
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={handleFileUpload}
              disabled={uploadDisabled}
            />
          </div>

          <div className="h-6 w-px bg-gray-300 mx-1 shrink-0"></div>

          {/* Drawing Tools */}
          <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border shrink-0">
            <ToolButton
              active={activeTool === "cursor"}
              onClick={() => setActiveTool("cursor")}
              icon={<MousePointer size={18} />}
              label="Select/Move"
            />
            <ToolButton
              active={activeTool === "pen"}
              onClick={() => setActiveTool("pen")}
              icon={<Pen size={18} />}
              label="Pen"
            />
            <ToolButton
              active={activeTool === "eraser"}
              onClick={() => setActiveTool("eraser")}
              icon={<Eraser size={18} />}
              label="Eraser"
            />
            <div className="w-px h-6 bg-gray-200 mx-1"></div>
            <ToolButton
              active={activeTool === "line"}
              onClick={() => setActiveTool("line")}
              icon={<Minus size={18} />}
              label="Line"
            />
            <ToolButton
              active={activeTool === "arrow"}
              onClick={() => setActiveTool("arrow")}
              icon={<ArrowRight size={18} />}
              label="Arrow"
            />
            <ToolButton
              active={activeTool === "rect"}
              onClick={() => setActiveTool("rect")}
              icon={<Square size={18} />}
              label="Rectangle"
            />
            <ToolButton
              active={activeTool === "circle"}
              onClick={() => setActiveTool("circle")}
              icon={<Circle size={18} />}
              label="Circle"
            />
            <ToolButton
              active={activeTool === "text"}
              onClick={() => setActiveTool("text")}
              icon={<Type size={18} />}
              label="Text"
            />
          </div>

          <div className="h-6 w-px bg-gray-300 mx-1 shrink-0"></div>

          {/* Properties */}
          {activeTool !== "eraser" && (
            <div className="flex items-center gap-3 shrink-0 animate-in fade-in zoom-in duration-200">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 shadow-sm"
              />
              <button
                onClick={() => setIsFilled(!isFilled)}
                className={`p-2 rounded hover:bg-gray-200 ${isFilled ? "bg-blue-100 text-blue-600" : "text-gray-500"}`}
                title="Toggle Fill"
              >
                <PaintBucket size={18} />
              </button>
              <div className="flex flex-col w-20">
                 <input
                  type="range"
                  min={activeTool === 'text' ? "8" : "1"}
                  max={activeTool === 'text' ? "72" : "20"}
                  value={activeTool === 'text' ? fontSize : lineWidth}
                  onChange={(e) => activeTool === 'text' ? setFontSize(parseInt(e.target.value)) : setLineWidth(parseInt(e.target.value))}
                  className="h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
          )}
        </div>

        {/* Right Actions: Pagination & Export */}
        <div className="flex items-center gap-3 shrink-0 ml-auto">
          {/* Pagination Controls */}
          {pdfDoc && (
             <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border">
                <button 
                  onClick={() => changePage(-1)}
                  disabled={pageNum <= 1}
                  className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="text-sm font-medium min-w-[3rem] text-center">
                   {pageNum} / {totalPages}
                </span>
                <button 
                  onClick={() => changePage(1)}
                  disabled={pageNum >= totalPages}
                  className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                >
                  <ChevronRight size={18} />
                </button>
             </div>
          )}

          <div className="h-6 w-px bg-gray-300 mx-1"></div>

          <div className="flex items-center gap-1">
             <button
               onClick={() => setScale(s => Math.min(5, s + 0.1))}
               className="p-2 hover:bg-gray-100 rounded text-gray-600 hidden sm:block"
               title="Zoom In"
             >
               <ZoomIn size={18} />
             </button>
             <button
               onClick={() => setScale(s => Math.max(0.25, s - 0.1))}
               className="p-2 hover:bg-gray-100 rounded text-gray-600 hidden sm:block"
               title="Zoom Out"
             >
               <ZoomOut size={18} />
             </button>
          </div>

          <button
            onClick={undoLast}
            className="p-2 hover:bg-gray-100 rounded text-gray-600"
            title="Undo"
          >
            <RotateCcw size={18} />
          </button>
          
          <button
            onClick={() => {
               if(confirm("Clear all annotations on this page?")) {
                  setAnnotations(prev => ({ ...prev, [pageNum]: [] }));
               }
            }}
            className="p-2 hover:bg-red-50 text-red-500 rounded"
            title="Clear Page"
          >
            <Trash2 size={18} />
          </button>

          <button
            onClick={exportPDF}
            disabled={!pdfDoc}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              !pdfDoc
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
            }`}
          >
            <Save size={18} />
            <span className="hidden sm:inline">Save</span>
          </button>
        </div>
      </div>

      {/* Main Workspace */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-gray-200 relative cursor-default"
        style={{ touchAction: "none" }}
        onPointerDown={handleContainerPointerDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!pdfDoc ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-gray-500">
             <div className="bg-white p-10 rounded-2xl shadow-sm text-center max-w-md border border-gray-100">
               <div className="bg-blue-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
                 <Upload size={32} className="text-blue-600" />
               </div>
               <h3 className="text-xl font-bold text-gray-800 mb-2">Upload a Document</h3>
               <p className="mb-8 text-gray-500">Select a PDF file to start annotating.</p>
               <label
                className={`px-6 py-3 rounded-xl font-medium transition inline-block ${
                  uploadDisabled
                    ? "bg-gray-100 text-gray-400 cursor-wait"
                    : "bg-blue-600 text-white hover:bg-blue-700 hover:shadow-lg hover:-translate-y-0.5 transform duration-200 cursor-pointer"
                }`}
              >
                {uploadDisabled ? "Initializing..." : "Choose PDF File"}
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={handleFileUpload}
                  disabled={uploadDisabled}
                />
              </label>
             </div>
          </div>
        ) : (
          <div className="p-8 w-max h-max mx-auto">
            <div
              className="relative shadow-xl origin-top-left ring-1 ring-black/5"
              style={{
                width: "fit-content",
                height: "fit-content",
                cursor: isPanningState
                  ? "grabbing"
                  : activeTool === "cursor"
                  ? "default"
                  : "crosshair",
              }}
            >
              <canvas ref={pdfCanvasRef} className="bg-white block" />
              <canvas
                ref={canvasRef}
                className="absolute top-0 left-0"
                style={{ touchAction: "none" }}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                onPointerLeave={handleCanvasPointerUp}
                onContextMenu={(e) => e.preventDefault()}
              />

              {/* Text Input Overlay */}
              {textInput && (
                <div
                  className="absolute z-50 flex items-center gap-2"
                  style={{
                    left: textInput.x * scale,
                    top: textInput.y * scale - 8,
                  }}
                >
                  <input
                    ref={textInputRef}
                    autoFocus
                    value={textInput.text}
                    onChange={(e) =>
                      setTextInput({ ...textInput, text: e.target.value })
                    }
                    onBlur={handleInputBlur}
                    onKeyDown={handleTextSubmit}
                    className="bg-white border border-blue-500 rounded px-2 py-1 outline-none text-blue-900 placeholder-blue-300 shadow-lg min-w-[200px]"
                    style={{
                      fontSize: `${fontSize * scale}px`,
                      fontFamily: "sans-serif",
                      color,
                      lineHeight: 1.2,
                    }}
                    placeholder="Type..."
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handlePolishText();
                    }}
                    disabled={isPolishing || !textInput.text}
                    className="bg-indigo-600 text-white p-1.5 rounded-full shadow-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                    title="AI Polish"
                  >
                    {isPolishing ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Sparkles size={16} />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const ToolButton = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={`p-2 rounded flex items-center justify-center transition-all ${
      active
        ? "bg-blue-100 text-blue-700 shadow-inner"
        : "hover:bg-gray-200 text-gray-600"
    }`}
    title={label}
  >
    {icon}
  </button>
);

export default App;
