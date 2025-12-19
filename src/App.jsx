import React, { useEffect, useRef, useState } from 'react'
import {
  Upload, Pen, Minus, Type, ChevronLeft, ChevronRight, RotateCcw, Trash2,
  Save, MousePointer, ZoomIn, ZoomOut, Square, Circle, Eraser, PaintBucket,
  Copy
} from 'lucide-react'

// External libs (CDN)
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

/** hit testing helpers */
const near = (a, b, tol = 6) => Math.abs(a - b) <= tol
const pointInRect = (p, a, b) => {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x)
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y)
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

export default function App() {
  const [pdfLib, setPdfLib] = useState(null)
  const [jspdfLib, setJspdfLib] = useState(null)
  const [pdfDoc, setPdfDoc] = useState(null)
  const [pageNum, setPageNum] = useState(1)
  const [scale, setScale] = useState(1.5)
  const [fileName, setFileName] = useState('document.pdf')

  // Tools: select, pen, line, rect, circle, text, eraser, hand (pan)
  const [activeTool, setActiveTool] = useState('select')
  const [color, setColor] = useState('#EF4444')
  const [lineWidth, setLineWidth] = useState(3)
  const [isFilled, setIsFilled] = useState(false)

  // data
  const [annotations, setAnnotations] = useState({})
  const [selected, setSelected] = useState({ page: null, index: null }) // selected ann

  // drawing state
  const [isDrawing, setIsDrawing] = useState(false)
  const [currentPath, setCurrentPath] = useState([])
  const [startPoint, setStartPoint] = useState(null)
  const [textInput, setTextInput] = useState(null)

  // selection/move state
  const draggingSel = useRef(false)
  const dragStartPDF = useRef(null)

  // refs
  const pdfCanvasRef = useRef(null)
  const drawCanvasRef = useRef(null)
  const fileInputRef = useRef(null)
  const scrollRef = useRef(null)
  const renderTaskRef = useRef(null)
  const renderReqId = useRef(0)

  // panning
  const isPanning = useRef(false)
  const panPt = useRef({ x: 0, y: 0 })

  /** load libraries */
  useEffect(() => {
    const go = async () => {
      if (!window.pdfjsLib) {
        const s = document.createElement('script')
        s.src = PDFJS_URL
        s.crossOrigin = 'anonymous'
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
          setPdfLib(window.pdfjsLib)
        }
        document.head.appendChild(s)
      } else setPdfLib(window.pdfjsLib)

      if (!window.jspdf) {
        const s2 = document.createElement('script')
        s2.src = JSPDF_URL
        s2.crossOrigin = 'anonymous'
        s2.onload = () => setJspdfLib(window.jspdf)
        document.head.appendChild(s2)
      } else setJspdfLib(window.jspdf)
    }
    go()
  }, [])

  /** upload PDF */
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file || !pdfLib) return
    setFileName(file.name)
    const r = new FileReader()
    r.onload = async (ev) => {
      try {
        const task = pdfLib.getDocument(new Uint8Array(ev.target.result))
        const pdf = await task.promise
        setPdfDoc(pdf)
        setPageNum(1)
        setAnnotations({})
        setSelected({ page: null, index: null })
      } catch (err) {
        console.error(err)
        alert('Failed to load PDF. Try another file.')
      }
    }
    r.readAsArrayBuffer(file)
  }

  /** wheel zoom (needs passive:false) */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        const delta = -e.deltaY
        setScale(s => Math.min(5, Math.max(0.5, s + delta * 0.002)))
      } else {
        const delta = -e.deltaY
        const step = 0.1
        setScale(s => Math.min(4, Math.max(0.25, s + (delta > 0 ? step : -step))))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /** render page */
  useEffect(() => { if (pdfDoc) renderPage(pageNum) }, [pdfDoc, pageNum, scale])
  const renderPage = async (n) => {
    renderReqId.current++
    const req = renderReqId.current
    if (renderTaskRef.current) { try { await renderTaskRef.current.cancel() } catch {} }
    try {
      const page = await pdfDoc.getPage(n)
      if (renderReqId.current !== req) return
      const viewport = page.getViewport({ scale })
      const pcan = pdfCanvasRef.current
      const dcan = drawCanvasRef.current
      if (!pcan || !dcan) return
      pcan.width = dcan.width = viewport.width
      pcan.height = dcan.height = viewport.height
      const ctx = pcan.getContext('2d')
      const task = page.render({ canvasContext: ctx, viewport })
      renderTaskRef.current = task
      await task.promise
      if (renderReqId.current === req) {
        renderTaskRef.current = null
        drawAnnotations()
      }
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e)
    }
  }

  /** draw all annotations + selection */
  useEffect(() => { drawAnnotations() }, [annotations, pageNum, scale, isDrawing, startPoint, isFilled, color, lineWidth, selected])
  const drawAnnotations = () => {
    const can = drawCanvasRef.current
    if (!can) return
    const ctx = can.getContext('2d')
    ctx.clearRect(0, 0, can.width, can.height)

    const drawOne = (ann, sel = false) => {
      ctx.save()
      ctx.globalCompositeOperation = ann.type === 'eraser' ? 'destination-out' : 'source-over'
      ctx.strokeStyle = ann.color
      ctx.lineWidth = (ann.width || 2) * scale
      ctx.fillStyle = ann.color
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      if (ann.type === 'pen' || ann.type === 'eraser') {
        ctx.beginPath()
        if (ann.points.length) {
          ctx.moveTo(ann.points[0].x * scale, ann.points[0].y * scale)
          ann.points.forEach(p => ctx.lineTo(p.x * scale, p.y * scale))
        }
        ctx.stroke()
      } else if (ann.type === 'line') {
        ctx.beginPath()
        ctx.moveTo(ann.start.x * scale, ann.start.y * scale)
        ctx.lineTo(ann.end.x * scale, ann.end.y * scale)
        ctx.stroke()
      } else if (ann.type === 'rect') {
        const x = ann.start.x * scale, y = ann.start.y * scale
        const w = (ann.end.x - ann.start.x) * scale, h = (ann.end.y - ann.start.y) * scale
        ctx.beginPath()
        ctx.rect(x, y, w, h)
        if (ann.filled) ctx.fill()
        ctx.stroke()
      } else if (ann.type === 'circle') {
        ctx.beginPath()
        ctx.arc(ann.center.x * scale, ann.center.y * scale, ann.radius * scale, 0, Math.PI * 2)
        if (ann.filled) ctx.fill()
        ctx.stroke()
      } else if (ann.type === 'text') {
        ctx.font = `${ann.size * scale}px sans-serif`
        ctx.textBaseline = 'top'
        ctx.fillText(ann.text, ann.x * scale, ann.y * scale)
      }

      // selection highlight
      if (sel) {
        ctx.strokeStyle = '#1d4ed8'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 4])
        const bb = getAnnBounds(ann)
        ctx.strokeRect(bb.x * scale, bb.y * scale, bb.w * scale, bb.h * scale)
      }
      ctx.restore()
    }

    const list = annotations[pageNum] || []
    list.forEach((ann, i) =>
      drawOne(ann, selected.page === pageNum && selected.index === i)
    )

    // preview shapes while drawing
    if (isDrawing) {
      const te = can.tempEnd
      if (!te) return
      const base = { color, width: lineWidth, filled: isFilled }
      if (activeTool === 'line' && startPoint) drawOne({ ...base, type: 'line', start: startPoint, end: te })
      if (activeTool === 'rect' && startPoint) drawOne({ ...base, type: 'rect', start: startPoint, end: te })
      if (activeTool === 'circle' && startPoint) {
        const r = dist(startPoint, te)
        drawOne({ ...base, type: 'circle', center: startPoint, radius: r })
      }
      if (activeTool === 'pen') drawOne({ ...base, type: 'pen', points: currentPath })
    }
  }

  /** get bounding box used for selection */
  const getAnnBounds = (ann) => {
    if (ann.type === 'pen' || ann.type === 'eraser') {
      const xs = ann.points.map(p => p.x), ys = ann.points.map(p => p.y)
      const x = Math.min(...xs), y = Math.min(...ys)
      const w = Math.max(...xs) - x, h = Math.max(...ys) - y
      return { x, y, w, h }
    } else if (ann.type === 'line') {
      const x = Math.min(ann.start.x, ann.end.x)
      const y = Math.min(ann.start.y, ann.end.y)
      const w = Math.abs(ann.end.x - ann.start.x)
      const h = Math.abs(ann.end.y - ann.start.y)
      return { x, y, w, h }
    } else if (ann.type === 'rect') {
      const x = Math.min(ann.start.x, ann.end.x)
      const y = Math.min(ann.start.y, ann.end.y)
      const w = Math.abs(ann.end.x - ann.start.x)
      const h = Math.abs(ann.end.y - ann.start.y)
      return { x, y, w, h }
    } else if (ann.type === 'circle') {
      return { x: ann.center.x - ann.radius, y: ann.center.y - ann.radius, w: 2 * ann.radius, h: 2 * ann.radius }
    } else if (ann.type === 'text') {
      // approximate text box
      return { x: ann.x, y: ann.y, w: ann.text.length * (ann.size * 0.6), h: ann.size }
    }
    return { x: 0, y: 0, w: 0, h: 0 }
  }

  /** hit test for selection (pdf coords) */
  const hitTest = (pt) => {
    const list = annotations[pageNum] || []
    for (let i = list.length - 1; i >= 0; i--) {
      const ann = list[i]
      if (ann.type === 'line') {
        // distance to segment
        const A = ann.start, B = ann.end
        const AB = { x: B.x - A.x, y: B.y - A.y }
        const AP = { x: pt.x - A.x, y: pt.y - A.y }
        const t = Math.max(0, Math.min(1, (AP.x * AB.x + AP.y * AB.y) / (AB.x * AB.x + AB.y * AB.y)))
        const proj = { x: A.x + t * AB.x, y: A.y + t * AB.y }
        if (dist(proj, pt) <= (8 / scale)) return i
      } else if (ann.type === 'pen' || ann.type === 'eraser') {
        for (let k = 0; k < ann.points.length - 1; k++) {
          const A = ann.points[k], B = ann.points[k + 1]
          const AB = { x: B.x - A.x, y: B.y - A.y }
          const AP = { x: pt.x - A.x, y: pt.y - A.y }
          const t = Math.max(0, Math.min(1, (AP.x * AB.x + AP.y * AB.y) / (AB.x * AB.x + AB.y * AB.y)))
          const proj = { x: A.x + t * AB.x, y: A.y + t * AB.y }
          if (dist(proj, pt) <= (8 / scale)) return i
        }
      } else if (ann.type === 'rect') {
        const inside = pointInRect(pt, ann.start, ann.end)
        if (inside || near(pt.x, ann.start.x, 6 / scale) || near(pt.x, ann.end.x, 6 / scale)) return i
      } else if (ann.type === 'circle') {
        const d = dist(pt, ann.center)
        if (Math.abs(d - ann.radius) <= (8 / scale) || d < ann.radius) return i
      } else if (ann.type === 'text') {
        const bb = getAnnBounds(ann)
        if (pt.x >= bb.x && pt.x <= bb.x + bb.w && pt.y >= bb.y && pt.y <= bb.y + bb.h) return i
      }
    }
    return -1
  }

  /** coords helpers */
  const toPdfCoords = (e) => {
    const can = drawCanvasRef.current
    const r = can.getBoundingClientRect()
    const sx = can.width / r.width, sy = can.height / r.height
    const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy
    return { x: x / scale, y: y / scale }
  }

  /** draw start / move / stop */
  const onDrawStart = (e) => {
    if (e.button !== 0) return
    if (activeTool === 'hand') return
    if (activeTool === 'select') {
      const pt = toPdfCoords(e)
      const idx = hitTest(pt)
      if (idx >= 0) {
        setSelected({ page: pageNum, index: idx })
        draggingSel.current = true
        dragStartPDF.current = pt
      } else {
        setSelected({ page: null, index: null })
      }
      return
    }

    // text tool: create overlay input
    if (activeTool === 'text') {
      const pt = toPdfCoords(e)
      if (!textInput) setTextInput({ x: pt.x, y: pt.y, text: '' })
      return
    }

    const pt = toPdfCoords(e)
    setIsDrawing(true)
    setStartPoint(pt)
    if (activeTool === 'pen' || activeTool === 'eraser') setCurrentPath([pt])
  }
  const onDrawMove = (e) => {
    if (activeTool === 'hand') return
    const pt = toPdfCoords(e)

    // moving a selected object
    if (activeTool === 'select' && draggingSel.current && selected.page === pageNum && selected.index != null) {
      const delta = { x: pt.x - dragStartPDF.current.x, y: pt.y - dragStartPDF.current.y }
      dragStartPDF.current = pt
      setAnnotations(prev => {
        const arr = [...(prev[pageNum] || [])]
        const ann = { ...arr[selected.index] }
        if (ann.type === 'pen' || ann.type === 'eraser') {
          ann.points = ann.points.map(p => ({ x: p.x + delta.x, y: p.y + delta.y }))
        } else if (ann.type === 'line') {
          ann.start = { x: ann.start.x + delta.x, y: ann.start.y + delta.y }
          ann.end   = { x: ann.end.x + delta.x,   y: ann.end.y + delta.y }
        } else if (ann.type === 'rect') {
          ann.start = { x: ann.start.x + delta.x, y: ann.start.y + delta.y }
          ann.end   = { x: ann.end.x + delta.x,   y: ann.end.y + delta.y }
        } else if (ann.type === 'circle') {
          ann.center = { x: ann.center.x + delta.x, y: ann.center.y + delta.y }
        } else if (ann.type === 'text') {
          ann.x += delta.x; ann.y += delta.y
        }
        arr[selected.index] = ann
        return { ...prev, [pageNum]: arr }
      })
      return
    }

    if (!isDrawing) return
    if (activeTool === 'pen' || activeTool === 'eraser') setCurrentPath(prev => [...prev, pt])
    else if (['line', 'rect', 'circle'].includes(activeTool)) {
      const can = drawCanvasRef.current
      can.tempEnd = pt
      drawAnnotations()
    }
  }
  const onDrawEnd = () => {
    if (activeTool === 'select') { draggingSel.current = false; return }
    if (!isDrawing) return
    const can = drawCanvasRef.current
    const te = can?.tempEnd || null
    const base = { color: activeTool === 'eraser' ? '#ffffff' : color, width: activeTool === 'eraser' ? 20 : lineWidth, filled: isFilled }
    let newAnn = null

    if (activeTool === 'pen' || activeTool === 'eraser') newAnn = { ...base, type: activeTool, points: currentPath }
    else if (activeTool === 'line' && startPoint && te) newAnn = { ...base, type: 'line', start: startPoint, end: te }
    else if (activeTool === 'rect' && startPoint && te) newAnn = { ...base, type: 'rect', start: startPoint, end: te }
    else if (activeTool === 'circle' && startPoint && te) newAnn = { ...base, type: 'circle', center: startPoint, radius: dist(startPoint, te) }

    if (newAnn) setAnnotations(p => ({ ...p, [pageNum]: [ ...(p[pageNum] || []), newAnn ] }))
    setIsDrawing(false)
    setCurrentPath([])
    setStartPoint(null)
    if (drawCanvasRef.current) drawCanvasRef.current.tempEnd = null
  }

  /** text finalize / keyboard */
  const onTextKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      finalizeText()
    }
  }
  const finalizeText = () => {
    if (!textInput) return
    const txt = textInput.text.trim()
    if (!txt) { setTextInput(null); return }
    const ann = { type: 'text', x: textInput.x, y: textInput.y, text: txt, color, size: 16 }
    setAnnotations(p => ({ ...p, [pageNum]: [ ...(p[pageNum] || []), ann ] }))
    setTextInput(null)
  }

  /** selection duplication */
  const duplicateSelection = () => {
    if (selected.page !== pageNum || selected.index == null) return
    setAnnotations(prev => {
      const arr = [...(prev[pageNum] || [])]
      const src = arr[selected.index]
      if (!src) return prev
      const shift = 8 / scale
      const copyAnn = JSON.parse(JSON.stringify(src))
      const shiftPt = (p) => ({ x: p.x + shift, y: p.y + shift })
      if (copyAnn.type === 'pen' || copyAnn.type === 'eraser') copyAnn.points = copyAnn.points.map(shiftPt)
      else if (copyAnn.type === 'line') { copyAnn.start = shiftPt(copyAnn.start); copyAnn.end = shiftPt(copyAnn.end) }
      else if (copyAnn.type === 'rect') { copyAnn.start = shiftPt(copyAnn.start); copyAnn.end = shiftPt(copyAnn.end) }
      else if (copyAnn.type === 'circle') copyAnn.center = shiftPt(copyAnn.center)
      else if (copyAnn.type === 'text') { copyAnn.x += shift; copyAnn.y += shift }
      arr.push(copyAnn)
      return { ...prev, [pageNum]: arr }
    })
  }

  /** pan with middle/right mouse */
  const onPanDown = (e) => {
    if (activeTool !== 'hand' && e.button !== 1 && e.button !== 2) return
    e.preventDefault()
    isPanning.current = true
    panPt.current = { x: e.clientX, y: e.clientY }
  }
  const onPanMove = (e) => {
    if (!isPanning.current) return
    e.preventDefault()
    const dx = e.clientX - panPt.current.x
    const dy = e.clientY - panPt.current.y
    scrollRef.current.scrollLeft -= dx
    scrollRef.current.scrollTop  -= dy
    panPt.current = { x: e.clientX, y: e.clientY }
  }
  const onPanUp = () => { isPanning.current = false }
  const onContextMenu = (e) => e.preventDefault()

  /** export */
  const exportPDF = async () => {
    if (!pdfDoc || !jspdfLib) return
    const { jsPDF } = jspdfLib
    const doc = new jsPDF({ unit: 'pt', format: 'a4', putOnlyUsedFonts: true })
    doc.deletePage(1)
    const total = pdfDoc.numPages
    const S = 2

    for (let i = 1; i <= total; i++) {
      const page = await pdfDoc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      doc.addPage([base.width, base.height], base.width > base.height ? 'l' : 'p')
      const vp = page.getViewport({ scale: S })
      const c = document.createElement('canvas')
      c.width = vp.width; c.height = vp.height
      const ctx = c.getContext('2d')
      await page.render({ canvasContext: ctx, viewport: vp }).promise

      const anns = annotations[i] || []
      anns.forEach(a => {
        ctx.save()
        ctx.globalCompositeOperation = a.type === 'eraser' ? 'destination-out' : 'source-over'
        ctx.strokeStyle = a.color; ctx.fillStyle = a.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        ctx.lineWidth = (a.width || 2) * S
        if (a.type === 'pen' || a.type === 'eraser') {
          ctx.beginPath()
          if (a.points.length) {
            ctx.moveTo(a.points[0].x * S, a.points[0].y * S)
            a.points.forEach(p => ctx.lineTo(p.x * S, p.y * S))
          }
          ctx.stroke()
        } else if (a.type === 'line') {
          ctx.beginPath(); ctx.moveTo(a.start.x * S, a.start.y * S); ctx.lineTo(a.end.x * S, a.end.y * S); ctx.stroke()
        } else if (a.type === 'rect') {
          const x = a.start.x * S, y = a.start.y * S, w = (a.end.x - a.start.x) * S, h = (a.end.y - a.start.y) * S
          ctx.beginPath(); ctx.rect(x, y, w, h); if (a.filled) ctx.fill(); ctx.stroke()
        } else if (a.type === 'circle') {
          ctx.beginPath(); ctx.arc(a.center.x * S, a.center.y * S, a.radius * S, 0, Math.PI * 2); if (a.filled) ctx.fill(); ctx.stroke()
        } else if (a.type === 'text') {
          ctx.font = `${(a.size || 16) * S}px sans-serif`; ctx.textBaseline = 'top'; ctx.fillText(a.text, a.x * S, a.y * S)
        }
        ctx.restore()
      })

      const img = c.toDataURL('image/jpeg', 0.95)
      doc.addImage(img, 'JPEG', 0, 0, base.width, base.height)
    }
    doc.save(`edited_${fileName}`)
  }

  /** UI */

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Toolbar */}
      <div className="toolbar flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {/* upload */}
          <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-lg border">
            <button className="icon-btn" onClick={() => fileInputRef.current.click()}>
              <Upload size={18} /><span className="text-sm">&nbsp;Upload</span>
            </button>
            <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleFileUpload} />
          </div>

          {/* tools */}
          <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border">
            <Tool active={activeTool==='select'} onClick={()=>setActiveTool('select')} icon={<MousePointer size={18} />} label="Select/Move" />
            <Tool active={activeTool==='hand'} onClick={()=>setActiveTool('hand')} icon={<span style={{fontSize:12}}>👋</span>} label="Pan (hand / mid/right mouse)" />
            <div className="icon-btn" style={{cursor:'default', opacity:.35}}>|</div>
            <Tool active={activeTool==='pen'} onClick={()=>setActiveTool('pen')} icon={<Pen size={18} />} label="Pen" />
            <Tool active={activeTool==='eraser'} onClick={()=>setActiveTool('eraser')} icon={<Eraser size={18} />} label="Eraser" />
            <div className="icon-btn" style={{cursor:'default', opacity:.35}}>|</div>
            <Tool active={activeTool==='line'} onClick={()=>setActiveTool('line')} icon={<Minus size={18} />} label="Line" />
            <Tool active={activeTool==='rect'} onClick={()=>setActiveTool('rect')} icon={<Square size={18} />} label="Rectangle" />
            <Tool active={activeTool==='circle'} onClick={()=>setActiveTool('circle')} icon={<Circle size={18} />} label="Circle" />
            <Tool active={activeTool==='text'} onClick={()=>setActiveTool('text')} icon={<Type size={18} />} label="Text" />
          </div>

          {/* style */}
          <div className="flex items-center gap-3">
            <input type="color" value={color} onChange={(e)=>setColor(e.target.value)} className="icon-btn" title="Color" />
            <button className={`icon-btn ${isFilled?'icon-btn-active':''}`} onClick={()=>setIsFilled(v=>!v)} title="Fill (for rect/circle)">
              <PaintBucket size={18} />
            </button>
            <div className="flex items-center gap-2">
              <input
                type="range" min="1" max="10" value={lineWidth}
                onChange={e=>setLineWidth(parseInt(e.target.value))}
              />
              <span className="text-xs">{lineWidth}px</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="icon-btn" onClick={duplicateSelection} title="Duplicate selected"><Copy size={18} /></button>
          <button className="icon-btn" onClick={()=>{
            const arr = [...(annotations[pageNum] || [])]; if (!arr.length) return
            setAnnotations(p=>({ ...p, [pageNum]: arr.slice(0,-1) }))
          }} title="Undo last"><RotateCcw size={18} /></button>
          <button className="icon-btn" onClick={()=>setAnnotations(p=>({ ...p, [pageNum]: [] }))} title="Clear page"><Trash2 size={18} /></button>
          <button className="btn-primary" disabled={!pdfDoc} onClick={exportPDF}><Save size={18} />&nbsp;Save PDF</button>
        </div>
      </div>

      {/* Workspace */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-gray-200/60 relative py-8 flex justify-center no-scrollbar"
        onMouseDown={(e)=>{ onPanDown(e); }}
        onMouseMove={onPanMove}
        onMouseUp={onPanUp}
        onMouseLeave={onPanUp}
        onContextMenu={onContextMenu}
      >
        {/* IMPORTANT: put horizontal gutter INSIDE the scroll content (so pan reaches the edges) */}
        <div className="mx-8">
          {!pdfDoc ? (
            <div className="bg-white p-8 rounded-lg shadow-sm" style={{marginTop:80}}>
              <Upload size={48} className="text-gray-400" />
              <h3 className="text-gray-700">Upload a PDF to start</h3>
              <div className="p-2" />
              <button className="btn-primary" onClick={()=>fileInputRef.current.click()}>Choose PDF</button>
            </div>
          ) : (
            <div
              className="relative shadow-xl origin-top-left"
              style={{ width: 'fit-content', height: 'fit-content', cursor: isPanning.current ? 'grabbing' : (activeTool==='select' ? 'default' : 'crosshair') }}
            >
              <canvas ref={pdfCanvasRef} className="bg-white block" />
              <canvas
                ref={drawCanvasRef}
                className="absolute top-0 left-0"
                onMouseDown={onDrawStart}
                onMouseMove={onDrawMove}
                onMouseUp={onDrawEnd}
                onMouseLeave={onDrawEnd}
              />
              {textInput && (
                <div className="absolute" style={{ left: textInput.x * scale, top: (textInput.y * scale) - 4, zIndex: 50 }}>
                  <input
                    autoFocus
                    value={textInput.text}
                    onChange={(e)=>setTextInput({ ...textInput, text: e.target.value })}
                    onKeyDown={onTextKey}
                    onBlur={finalizeText}
                    className="bg-white border rounded-lg p-1"
                    style={{ font: `${16 * scale}px sans-serif`, minWidth: 120 }}
                    placeholder="Type…"
                    onMouseDown={(e)=>e.stopPropagation()}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer / Pagination */}
      {pdfDoc && (
        <div className="bg-white border-t p-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button className="icon-btn" onClick={()=>setScale(s=>Math.max(0.25, s-0.25))}><ZoomOut size={16} /></button>
            <span className="text-xs font-mono w-12" style={{textAlign:'center'}}>{Math.round(scale*100)}%</span>
            <button className="icon-btn" onClick={()=>setScale(s=>Math.min(4, s+0.25))}><ZoomIn size={16} /></button>
          </div>
          <div className="flex items-center gap-3">
            <button className="icon-btn" onClick={()=>setPageNum(p=>Math.max(1, p-1))} disabled={pageNum<=1}><ChevronLeft size={20} /></button>
            <span className="text-sm">Page {pageNum} of {pdfDoc.numPages}</span>
            <button className="icon-btn" onClick={()=>setPageNum(p=>Math.min(pdfDoc.numPages, p+1))} disabled={pageNum>=pdfDoc.numPages}><ChevronRight size={20} /></button>
          </div>
          <div className="text-xs text-gray-400" style={{maxWidth:240, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{fileName}</div>
        </div>
      )}
    </div>
  )
}

function Tool({ active, onClick, icon, label }) {
  return (
    <button className={`icon-btn ${active ? 'icon-btn-active' : ''}`} onClick={onClick} title={label}>
      {icon}
    </button>
  )
}
