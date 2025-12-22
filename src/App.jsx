import React, { useEffect, useRef, useState } from "react";
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
  ZoomIn,
  ZoomOut,
  Cloud,
  Undo2,
  Share2,
  Code2,
  Eye,
} from "lucide-react";

// External libraries
const PDFJS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

// --- Gemini API Helper (optional, used only for text polish button) ---
const callGemini = async (prompt, systemInstruction = "") => {
  const apiKey = ""; // optional
  if (!apiKey) throw new Error("No Gemini API key configured.");

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
  const [scale, setScale] = useState(1.5);
  const [fileName, setFileName] = useState("document.pdf");

  // Tools: 'cursor', 'pen', 'line', 'arrow', 'rect', 'circle', 'text', 'eraser'
  const [activeTool, setActiveTool] = useState("cursor");
  const [color, setColor] = useState("#2563EB"); // blue-ish like screenshot
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

  // Panning
  const isPanning = useRef(false);
  const [isPanningState, setIsPanningState] = useState(false);
  const startPan = useRef({ x: 0, y: 0, sl: 0, st: 0 });

  // Spacebar pan (reliable across browsers)
  const spaceDownRef = useRef(false);
  useEffect(() => {
    const down = (e) => {
      if (e.code === "Space") spaceDownRef.current = true;
    };
    const up = (e) => {
      if (e.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", down);
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
    start: { x: 0, y: 0 }, // PDF coords
    original: null, // deep copy
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
    const tol = 10 / scale; // 10px tolerance in PDF units
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
          };
          document.head.appendChild(s1);
        } else {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
          setPdfLib(window.pdfjsLib);
        }

        if (!window.jspdf) {
          const s2 = document.createElement("script");
          s2.src = JSPDF_URL;
          s2.onload = () => setJspdfLib(window.jspdf);
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

  // Handle File Upload
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
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

        // Reset input so selecting same file again triggers change
        if (fileInputRef.current) fileInputRef.current.value = "";
      } catch (error) {
        console.error("Error loading PDF:", error);
        alert("Error parsing PDF. Please try another file.");
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
  ]);

  // Focus text input
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
        setScale((s) => Math.min(5, Math.max(0.5, s + delta * 0.002)));
      } else {
        const zoomStep = 0.1;
        setScale((prev) => {
          const next = delta > 0 ? prev + zoomStep : prev - zoomStep;
          return Math.min(4, Math.max(0.25, next));
        });
      }
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

  // --- PAN: container pointer handlers ---
  const handleContainerPointerDown = (e) => {
    const isPanButton =
      e.button === 1 ||
      e.button === 2 ||
      (e.button === 0 && (activeTool === "cursor" || spaceDownRef.current));

    if (!isPanButton) return;

    e.preventDefault();

    const el = scrollContainerRef.current;
    if (!el) return;

    try {
      el.setPointerCapture(e.pointerId);
    } catch {}

    isPanning.current = true;
    setIsPanningState(true);
    document.body.style.cursor = "grabbing";

    startPan.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
  };

  const handleContainerPointerMove = (e) => {
    if (!isPanning.current) return;
    e.preventDefault();

    const el = scrollContainerRef.current;
    if (!el) return;

    const dx = e.clientX - startPan.current.x;
    const dy = e.clientY - startPan.current.y;

    el.scrollLeft = startPan.current.sl - dx;
    el.scrollTop = startPan.current.st - dy;
  };

  const handleContainerPointerUp = (e) => {
    if (!isPanning.current) return;

    const el = scrollContainerRef.current;
    if (el) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {}
    }

    isPanning.current = false;
    setIsPanningState(false);
    document.body.style.cursor = "default";
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

  // --- Text polish (optional) ---
  const handlePolishText = async () => {
    if (!textInput || !textInput.text.trim()) return;
    setIsPolishing(true);
    try {
      const prompt = `Rewrite the following text to be more professional, grammatically correct, and concise: "${textInput.text}". Return ONLY the rewritten text, no explanations.`;
      const polishedText = await callGemini(prompt, "You are a professional editor.");
      setTextInput((prev) => ({ ...prev, text: polishedText.trim() }));
    } catch (err) {
      console.warn("Polish unavailable:", err?.message || err);
    } finally {
      setIsPolishing(false);
    }
  };

  // --- Text finalize ---
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

  // --- Arrow drawing helper ---
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

  // --- Canvas: pointer handlers (select/move + drawing) ---
  const handleCanvasPointerDown = (e) => {
    if (e.button === 2) {
      // right click pans (container), don't stop propagation
      e.preventDefault();
      return;
    }

    // SPACE-pan: let container do it
    if (spaceDownRef.current) return;

    // Only left button edits/draws
    if (e.button !== 0) return;

    // Cursor tool: try select/move; if none, let container pan
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

        const pageAnns = annotations[pageNum] || [];
        dragAnnRef.current.original = deepCopyAnn(pageAnns[idx]);

        try {
          canvasRef.current?.setPointerCapture(e.pointerId);
        } catch {}
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

    try {
      canvasRef.current?.setPointerCapture(e.pointerId);
    } catch {}
  };

  const handleCanvasPointerMove = (e) => {
    // dragging annotation
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
    // finish moving
    if (dragAnnRef.current.active) {
      e.preventDefault();
      e.stopPropagation();
      dragAnnRef.current.active = false;
      dragAnnRef.current.index = -1;
      dragAnnRef.current.original = null;
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      } catch {}
      return;
    }

    // finish drawing
    if (!isDrawing) {
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      } catch {}
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
      newAnn = {
        ...baseProps,
        type: "rect",
        start: startPoint,
        end: coords,
        filled: isFilled,
      };
    } else if (activeTool === "circle") {
      const radius = Math.sqrt(
        Math.pow(coords.x - startPoint.x, 2) + Math.pow(coords.y - startPoint.y, 2)
      );
      newAnn = {
        ...baseProps,
        type: "circle",
        center: startPoint,
        radius,
        filled: isFilled,
      };
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

    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
  };

  // --- Draw annotations ---
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
        ctx.arc(
          ann.center.x * scale,
          ann.center.y * scale,
          ann.radius * scale,
          0,
          2 * Math.PI
        );
        if (ann.filled) ctx.fill();
        ctx.stroke();
      } else if (ann.type === "text") {
        ctx.font = `${ann.size * scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(ann.text, ann.x * scale, ann.y * scale);
      }

      // selection highlight
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

    // preview while drawing
    if (isDrawing) {
      const tempEnd = canvas.tempEnd;
      if (activeTool === "pen" || activeTool === "eraser") {
        drawItem(
          {
            type: activeTool,
            points: currentPath,
            color: activeTool === "eraser" ? "#ffffff" : color,
            width: activeTool === "eraser" ? 20 : lineWidth,
          },
          -999
        );
      } else if (startPoint && tempEnd) {
        if (activeTool === "line") {
          drawItem(
            { type: "line", start: startPoint, end: tempEnd, color, width: lineWidth },
            -999
          );
        } else if (activeTool === "arrow") {
          drawItem(
            { type: "arrow", start: startPoint, end: tempEnd, color, width: lineWidth },
            -999
          );
        } else if (activeTool === "rect") {
          drawItem(
            {
              type: "rect",
              start: startPoint,
              end: tempEnd,
              color,
              width: lineWidth,
              filled: isFilled,
            },
            -999
          );
        } else if (activeTool === "circle") {
          const r = Math.sqrt(
            Math.pow(tempEnd.x - startPoint.x, 2) + Math.pow(tempEnd.y - startPoint.y, 2)
          );
          drawItem(
            { type: "circle", center: startPoint, radius: r, color, width: lineWidth, filled: isFilled },
            -999
          );
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

  const clearPage = () => {
    setAnnotations((prev) => ({ ...prev, [pageNum]: [] }));
    setSelectedIndex(-1);
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
          const x1 = ann.start.x * s;
          const y1 = ann.start.y * s;
          const x2 = ann.end.x * s;
          const y2 = ann.end.y * s;
          const head = Math.max(10, ann.width * 3) * s;
          strokeArrowExport(ctx, x1, y1, x2, y2, head);
        } else if (ann.type === "rect") {
          const rx = ann.start.x * s;
          const ry = ann.start.y * s;
          const rw = (ann.end.x - ann.start.x) * s;
          const rh = (ann.end.y - ann.start.y) * s;
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          if (ann.filled) ctx.fill();
          ctx.stroke();
        } else if (ann.type === "circle") {
          ctx.beginPath();
          ctx.arc(ann.center.x * s, ann.center.y * s, ann.radius * s, 0, 2 * Math.PI);
          if (ann.filled) ctx.fill();
          ctx.stroke();
        } else if (ann.type === "text") {
          ctx.font = `${ann.size * s}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textBaseline = "top";
          ctx.fillText(ann.text, ann.x * s, ann.y * s);
        }

        ctx.restore();
      });

      const imgData = canvas.toDataURL("image/jpeg", 0.95);
      doc.addImage(imgData, "JPEG", 0, 0, originalViewport.width, originalViewport.height);
    }

    doc.save(`edited_${fileName}`);
  };

  const zoomIn = () => setScale((s) => Math.min(4, s + 0.15));
  const zoomOut = () => setScale((s) => Math.max(0.25, s - 0.15));

  return (
    <div className="h-screen w-screen flex flex-col bg-[#F3F4F6] text-slate-900">
      {/* ===================== TOP DARK BAR (like screenshot) ===================== */}
      <div className="h-12 bg-[#0B0F1A] text-white flex items-center justify-between px-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
            <span className="text-xs font-semibold">PDF</span>
          </div>
          <div className="font-semibold tracking-tight">PDF Editor</div>

          <div className="flex items-center gap-2 ml-2 text-white/70">
            <IconPillButton title="Cloud">
              <Cloud size={16} />
            </IconPillButton>
            <IconPillButton title="Undo (demo)">
              <Undo2 size={16} />
            </IconPillButton>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Code / Preview segmented */}
          <div className="flex items-center bg-white/10 rounded-full p-1">
            <button
              className="px-3 py-1 rounded-full text-xs font-medium text-white/70 hover:text-white flex items-center gap-2"
              type="button"
            >
              <Code2 size={14} />
              Code
            </button>
            <button
              className="px-3 py-1 rounded-full text-xs font-medium bg-white text-black flex items-center gap-2"
              type="button"
            >
              <Eye size={14} />
              Preview
            </button>
          </div>

          <button
            className="px-3 py-1.5 rounded-full bg-[#1D4ED8] hover:bg-[#1E40AF] text-white text-xs font-semibold flex items-center gap-2"
            type="button"
          >
            <Share2 size={14} />
            Share
          </button>

          <button
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center"
            title="Close (demo)"
            type="button"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ===================== LIGHT TOOLBAR ROW ===================== */}
      <div className="bg-white border-b border-slate-200 h-14 flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          {/* Open button */}
          <label
            htmlFor="pdf-upload"
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm font-medium"
            title="Open PDF"
          >
            <Upload size={16} />
            Open
          </label>
          <input
            id="pdf-upload"
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={handleFileUpload}
          />

          <div className="w-px h-7 bg-slate-200 mx-2" />

          {/* Tool icons row (like screenshot) */}
          <div className="flex items-center gap-1 bg-white rounded-xl border border-slate-200 p-1">
            <ToolIcon
              active={activeTool === "cursor"}
              onClick={() => setActiveTool("cursor")}
              title="Select / Move (drag object). Pan: drag empty / right / middle / SPACE"
            >
              <MousePointer size={16} />
            </ToolIcon>

            <ToolIcon active={activeTool === "pen"} onClick={() => setActiveTool("pen")} title="Pen">
              <Pen size={16} />
            </ToolIcon>

            <ToolIcon active={activeTool === "eraser"} onClick={() => setActiveTool("eraser")} title="Eraser">
              <Eraser size={16} />
            </ToolIcon>

            <div className="w-px h-6 bg-slate-200 mx-1" />

            <ToolIcon active={activeTool === "line"} onClick={() => setActiveTool("line")} title="Line">
              <Minus size={16} />
            </ToolIcon>

            <ToolIcon active={activeTool === "arrow"} onClick={() => setActiveTool("arrow")} title="Arrow">
              <ArrowRight size={16} />
            </ToolIcon>

            <ToolIcon active={activeTool === "rect"} onClick={() => setActiveTool("rect")} title="Rectangle">
              <Square size={16} />
            </ToolIcon>

            <ToolIcon active={activeTool === "circle"} onClick={() => setActiveTool("circle")} title="Circle">
              <Circle size={16} />
            </ToolIcon>

            <ToolIcon active={activeTool === "text"} onClick={() => setActiveTool("text")} title="Text">
              <Type size={16} />
            </ToolIcon>
          </div>

          <div className="w-px h-7 bg-slate-200 mx-2" />

          {/* Simple style controls (kept, but compact) */}
          {activeTool !== "eraser" && (
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-9 h-9 rounded-xl cursor-pointer border border-slate-200 bg-white p-1"
                title="Color"
              />

              <button
                onClick={() => setIsFilled(!isFilled)}
                className={`w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center ${
                  isFilled ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                }`}
                title="Fill shapes"
                type="button"
              >
                <PaintBucket size={16} />
              </button>

              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={activeTool === "text" ? 8 : 1}
                  max={activeTool === "text" ? 72 : 10}
                  value={activeTool === "text" ? fontSize : lineWidth}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (activeTool === "text") setFontSize(v);
                    else setLineWidth(v);
                  }}
                  className="w-28"
                  title={activeTool === "text" ? "Font size" : "Line width"}
                />
                <div className="text-xs text-slate-500 w-10 text-right">
                  {activeTool === "text" ? `${fontSize}px` : `${lineWidth}px`}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right-side toolbar controls (zoom / undo / trash / save) */}
        <div className="flex items-center gap-2">
          <IconButton title="Zoom in" onClick={zoomIn}>
            <ZoomIn size={18} />
          </IconButton>
          <IconButton title="Zoom out" onClick={zoomOut}>
            <ZoomOut size={18} />
          </IconButton>

          <div className="w-px h-7 bg-slate-200 mx-2" />

          <IconButton title="Undo" onClick={undoLast}>
            <RotateCcw size={18} />
          </IconButton>

          <IconButton title="Clear page" onClick={clearPage} danger>
            <Trash2 size={18} />
          </IconButton>

          <button
            onClick={exportPDF}
            disabled={!pdfDoc}
            className={`ml-2 px-4 py-2 rounded-xl text-sm font-semibold border ${
              !pdfDoc
                ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
                : "bg-white hover:bg-slate-50 text-slate-900 border-slate-200"
            } flex items-center gap-2`}
            type="button"
          >
            <Save size={16} />
            Save
          </button>
        </div>
      </div>

      {/* ===================== WORKSPACE ===================== */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-[#E5E7EB] relative"
        style={{ userSelect: "none", touchAction: "none" }}
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handleContainerPointerUp}
        onPointerCancel={handleContainerPointerUp}
        onPointerLeave={handleContainerPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!pdfDoc ? (
          // Empty state card – matches screenshot vibe
          <div className="h-full w-full flex items-center justify-center p-6">
            <div className="w-[360px] max-w-[90vw] bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-[#EAF2FF] mx-auto flex items-center justify-center mb-4">
                <Upload className="text-[#2563EB]" size={26} />
              </div>
              <div className="text-lg font-semibold text-slate-900">Upload a Document</div>
              <div className="text-sm text-slate-500 mt-1">
                Select a PDF file to start annotating.
              </div>

              <label
                htmlFor="pdf-upload"
                className="inline-flex items-center justify-center mt-6 px-5 py-2.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold cursor-pointer"
              >
                Choose PDF File
              </label>
            </div>
          </div>
        ) : (
          <div className="p-8 w-max h-max">
            <div
              className="relative shadow-[0_20px_60px_rgba(0,0,0,0.15)] origin-top-left bg-white"
              style={{
                width: "fit-content",
                height: "fit-content",
                cursor: isPanningState
                  ? "grabbing"
                  : activeTool === "cursor"
                  ? "grab"
                  : "crosshair",
              }}
              title="Pan: drag empty area, middle mouse, right mouse, or hold SPACE + drag"
            >
              <canvas ref={pdfCanvasRef} className="bg-white block" />

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
                    onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
                    onBlur={handleInputBlur}
                    onKeyDown={handleTextSubmit}
                    className="bg-white border border-[#2563EB] rounded-xl px-3 py-2 outline-none shadow-lg min-w-[220px]"
                    style={{
                      fontSize: `${fontSize * scale}px`,
                      fontFamily: "ui-sans-serif, system-ui, sans-serif",
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
                    className="bg-[#4F46E5] text-white p-2 rounded-xl shadow-lg hover:bg-[#4338CA] disabled:opacity-50"
                    title="Rewrite with AI (optional)"
                    type="button"
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

        {/* Floating right-side pill (visual only, like screenshot) */}
        <div className="fixed right-6 bottom-10 hidden md:flex flex-col items-center gap-3 bg-black/85 text-white rounded-2xl px-2 py-3 shadow-lg">
          <div className="w-7 h-7 rounded-xl bg-white/10 flex items-center justify-center" title="Menu (demo)">
            <div className="grid grid-cols-3 gap-1">
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
              <span className="w-1 h-1 bg-white/80 rounded-full" />
            </div>
          </div>
          <div className="w-7 h-7 rounded-xl bg-white/10 flex items-center justify-center" title="Tools (demo)">
            ✦
          </div>
          <div className="w-7 h-7 rounded-xl bg-white/10 flex items-center justify-center" title="Dock (demo)">
            ▥
          </div>
        </div>
      </div>
    </div>
  );
};

/* ===================== Small UI helpers ===================== */

const ToolIcon = ({ active, onClick, title, children }) => (
  <button
    onClick={onClick}
    title={title}
    type="button"
    className={`w-10 h-10 rounded-xl flex items-center justify-center border transition ${
      active
        ? "bg-[#EAF2FF] text-[#2563EB] border-[#BFDBFE]"
        : "bg-white text-slate-600 border-transparent hover:bg-slate-50 hover:border-slate-200"
    }`}
  >
    {children}
  </button>
);

const IconButton = ({ title, onClick, children, danger = false }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`w-10 h-10 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center ${
      danger ? "text-red-500 hover:bg-red-50" : "text-slate-700"
    }`}
  >
    {children}
  </button>
);

const IconPillButton = ({ title, children }) => (
  <button
    type="button"
    title={title}
    className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center"
  >
    {children}
  </button>
);

export default App;
