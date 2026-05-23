// ─────────────────────────────────────────────────────────────────────────────
// sidepanel.tsx — Plasmo Side Panel Page
//
// In Metrics this was split across two files:
//   sidepanel.html  — HTML structure + all CSS styles
//   sidepanel.js    — all JS logic (message listener, updateUI, SCAN_FUNC, etc.)
//
// In Plasmo both are merged into this single React component.
// Plasmo auto-detects src/sidepanel.tsx and registers it as the side panel page.
//
// What this sidepanel shows:
//   1. Live stats grid  — JS Heap, DOM Nodes, DOM Depth, Long Task count
//   2. Culprit Finder   — scans the page for perf bottlenecks, ▲▼ navigation
//   3. Core Web Vitals  — CLS, FCP, LCP, SI, FLT, INP, FID, TBT (live, color-coded)
//   4. Network Hints    — preconnect / dns-prefetch tags found on the page
//   5. Listener Pressure — total expensive event listeners tracked by tracker.ts
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react"

// ── Types ─────────────────────────────────────────────────────────────────────

// Shape returned by the injected live-stats script
interface LiveStats {
  memory: string | null  // JS heap in MB, or null if API unavailable
  nodes:  number         // total DOM node count
  depth:  number         // maximum DOM nesting depth
}

// A single network hint link tag found on the page
interface Hint {
  rel:  string  // "preconnect" or "dns-prefetch"
  href: string  // the URL the hint points to
}

interface SeoStats {
  title: string
  description: string
  h1Count: number
  canonical: string
  robots: string
  imagesTotal: number
  imagesMissingAlt: number
  xRobotsTag?: string
  robotsTxtBlocked?: boolean
  indexableStatus?: string
}

interface Hop {
  url: string
  statusCode: number
}

// Result returned by SCAN_FUNC after scanning the page for culprits
interface ScanResult {
  found:     number                    // total culprits found
  counts:    Record<string, number>    // breakdown by type: { Image: 2, Video: 1, ... }
  firstType: string                    // type of the first culprit (for status text)
}

// Result returned by NAVIGATE_FUNC after scrolling to a culprit
interface NavResult {
  ok:   boolean  // false if the element wasn't found
  idx:  number   // the index we navigated to
  type: string   // culprit type at that index
}

// ── Metric Info Map ───────────────────────────────────────────────────────────
// Equivalent to the METRIC_INFO object in sidepanel.js.
// Used to populate the tooltip when the user clicks an (i) icon.
// Each entry has: full name, description, thresholds, and fix advice.
const METRIC_INFO: Record<string, { full: string; desc: string; goal: string; fix: string }> = {
  CLS:      { full: "Cumulative Layout Shift",      desc: 'Visual Stability. Measures how much elements "jump" during load.',  goal: "Excellent: < 0.1 | Poor: > 0.25",    fix: "Set specific widths/heights on images and ads." },
  FCP:      { full: "First Contentful Paint",        desc: "When the browser renders the first bit of text or image.",          goal: "Excellent: < 1.8s | Poor: > 3.0s",   fix: "Optimize server response times and minify CSS." },
  LCP:      { full: "Largest Contentful Paint",      desc: "When the main content of the page is visible.",                     goal: "Excellent: < 2.5s | Poor: > 4.0s",   fix: "Optimize the hero image or main text block." },
  SI:       { full: "Speed Index",                   desc: "How quickly the page is visually populated.",                       goal: "Excellent: < 3.4s | Poor: > 5.8s",   fix: "Reduce JavaScript execution and prioritize visible content." },
  FLT:      { full: "Font Load Time",                desc: "Delay caused by custom web fonts.",                                 goal: "Ideal: < 1.0s | Issue: > 2.0s",      fix: "Use font-display: swap to prevent invisible text." },
  INP:      { full: "Interaction to Next Paint",     desc: "Overall responsiveness to user input.",                             goal: "Excellent: < 200ms | Poor: > 500ms",  fix: "Break up long tasks (Long Tasks > 50ms)." },
  FID:      { full: "First Input Delay",             desc: "Responsiveness of the very first click.",                           goal: "Excellent: < 100ms | Poor: > 300ms",  fix: "Reduce main-thread blocking JavaScript." },
  TBT:      { full: "Total Blocking Time",           desc: "Measures UI freezes > 50ms on the main thread.",                   goal: "Excellent: < 200ms | Poor: > 600ms",  fix: "Optimize heavy JavaScript execution." },
  HEAP:     { full: "JavaScript Heap Size",          desc: "The total memory used by your page's JavaScript.",                  goal: "Healthy: < 100MB | High: > 300MB",    fix: "Look for memory leaks or excessive global variables." },
  NODES:    { full: "DOM Node Count",                desc: "The total number of elements in the tree.",                         goal: "Excellent: < 1,500 | Poor: > 3,000",  fix: "Simplify HTML structure and use virtualization for lists." },
  DEPTH:    { full: "DOM Tree Depth",                desc: "How deeply nested your HTML elements are.",                         goal: "Excellent: < 15 | Poor: > 32",        fix: "Avoid deeply nested <div> wrappers." },
  PRESSURE: { full: "Active Listener Pressure",      desc: "Noise from expensive global listeners: Scroll, Mousemove, Resize, Wheel, Touchmove.", goal: "Healthy: < 15 | Bloated: > 30", fix: "Use Throttling or Debouncing for Scroll/Mousemove." },
  NETWORK:  { full: "Network Hints",                 desc: "Optimization tags in the page header.",                             goal: "Goal: Preconnect to key domains (fonts, APIs).", fix: 'Add <link rel="preconnect"> to reduce connection overhead.' },
}

// ── Vital colour helper ───────────────────────────────────────────────────────
// Equivalent to the color-coding logic inside the VITALS_UPDATE handler in sidepanel.js.
// Returns green / yellow / red based on Google's Core Web Vitals thresholds.
const vitalColor = (metric: string, raw: string): string => {
  const val = parseFloat(raw)
  if (metric === "CLS")       return val < 0.1   ? "#00ff88" : val < 0.25  ? "#ffaa00" : "#ff4455"
  if (metric === "TBT")       return val < 200   ? "#00ff88" : val < 600   ? "#ffaa00" : "#ff4455"
  if (metric === "LCP")       return val < 2500  ? "#00ff88" : val < 4000  ? "#ffaa00" : "#ff4455"
  if (metric === "FCP")       return val < 1800  ? "#00ff88" : val < 3000  ? "#ffaa00" : "#ff4455"
  if (metric === "FLT")       return val < 1000  ? "#00ff88" : val < 2500  ? "#ffaa00" : "#ff4455"
  if (metric === "INP")       return val < 200   ? "#00ff88" : val < 500   ? "#ffaa00" : "#ff4455"
  if (metric === "FID")       return val < 100   ? "#00ff88" : val < 300   ? "#ffaa00" : "#ff4455"
  if (metric === "SI")        return val < 3400  ? "#00ff88" : val < 5800  ? "#ffaa00" : "#ff4455"
  return "#e0e0e0"
}

// ── SCAN_FUNC ─────────────────────────────────────────────────────────────────
// Equivalent to SCAN_FUNC in sidepanel.js.
// This function is SERIALIZED and injected into the active tab via
// chrome.scripting.executeScript — it cannot reference any variables from
// this file. It runs entirely inside the page's context.
//
// Scans for 5 culprit types:
//   1. Images   — incomplete or already flagged by content.tsx
//   2. Videos   — autoplay without muted, or missing poster attribute
//   3. IFrames  — not lazy-loaded (eager iframes block the main thread)
//   4. Text     — leaf nodes with > 800 chars (can delay LCP or cause CLS)
//   5. Listeners— elements flagged by tracker.ts with data-sentinel-bloat
//
// Tags each culprit with data-sentinel-idx and data-sentinel-type,
// adds the pulsing red outline class, and scrolls to the first one.
const SCAN_FUNC = () => {
  const culprits: { el: HTMLElement; type: string }[] = []

  // 1. Images — incomplete or already pulsing from content.tsx blame logic
  document.querySelectorAll("img").forEach((img) => {
    if (img.classList.contains("__sentinel-culprit") || !img.complete || img.naturalWidth === 0)
      culprits.push({ el: img, type: "Image" })
  })

  // 2. Videos — autoplay without muted burns CPU; missing poster causes layout shift
  document.querySelectorAll("video").forEach((vid) => {
    const isHeavy       = vid.autoplay && !vid.muted
    const missingPoster = !vid.poster && vid.preload !== "none"
    if (isHeavy || missingPoster)
      culprits.push({ el: vid as HTMLElement, type: "Video" })
  })

  // 3. IFrames — non-lazy iframes load eagerly and block the main thread
  document.querySelectorAll("iframe").forEach((ifr) => {
    if ((ifr as HTMLIFrameElement).loading !== "lazy")
      culprits.push({ el: ifr as HTMLElement, type: "IFrame" })
  })

  // 4. Large text blocks — leaf nodes with > 800 chars can delay LCP or cause CLS
  document.querySelectorAll("p, h1, h2, h3, div").forEach((el) => {
    if (el.children.length === 0 && (el as HTMLElement).innerText?.length > 800)
      culprits.push({ el: el as HTMLElement, type: "Text" })
  })

  // 5. Bloated listeners — flagged by tracker.ts when > 15 expensive listeners on one element
  document.querySelectorAll("[data-sentinel-bloat]").forEach((el) => {
    culprits.push({ el: el as HTMLElement, type: "Listener" })
  })

  if (culprits.length === 0) {
    console.error("DOM-Scout: 0 culprits found! (Enable 'Info' in DevTools to see the green success message!)")
    console.log("%c✅ [DOM-Scout] Zero performance culprits found! Great job optimizing this DOM.", "color:#00ff88; font-weight:bold; font-size:13px;")
    return { found: 0, counts: {}, firstType: "" }
  }

  // Ensure the pulse style exists on the page
  if (!document.getElementById("__sentinel-style")) {
    const s = document.createElement("style")
    s.id = "__sentinel-style"
    s.textContent = `
      @keyframes __sentinelPulse {
        0%,100% { outline: 5px solid #ff4455; outline-offset: 2px; }
        50%      { outline: 5px solid transparent; outline-offset: 2px; }
      }
      .__sentinel-culprit {
        animation: __sentinelPulse 0.8s ease-in-out infinite;
        outline: 5px solid #ff4455 !important;
        outline-offset: 2px !important;
      }
    `
    document.head.appendChild(s)
  }

  // Tag each culprit with its index + type, restart its pulse animation
  const counts: Record<string, number> = { Image: 0, Video: 0, Text: 0, IFrame: 0, Listener: 0 }
  culprits.forEach((item, i) => {
    item.el.dataset.sentinelIdx  = String(i)
    item.el.dataset.sentinelType = item.type
    item.el.classList.remove("__sentinel-culprit")
    void item.el.offsetWidth
    item.el.classList.add("__sentinel-culprit")
    item.el.title = `[Sentinel] ${item.type} Culprit #${i + 1}`
    counts[item.type]++
  })

  // ── Console report ────────────────────────────────────────────────────────
  console.group(
    `%c🔴 [DOM-Scout] Found ${culprits.length} culprit${culprits.length > 1 ? "s" : ""}`,
    "color:#ff4455; font-weight:bold; font-size:13px;"
  )

  culprits.forEach((item, i) => {
    const el = item.el
    const tag = el.tagName.toLowerCase()

    // Build a concise selector: tag + id + first class
    const id  = el.id ? `#${el.id}` : ""
    const cls = el.classList.length ? `.${el.classList[0]}` : ""
    const selector = `${tag}${id}${cls}` || tag

    // Type-specific detail
    let detail = ""
    if (item.type === "Image") {
      detail = `src="${(el as HTMLImageElement).src || "unknown"}" — ${
        !(el as HTMLImageElement).complete || (el as HTMLImageElement).naturalWidth === 0
          ? "not fully loaded"
          : "flagged by long-task blame"
      }`
    } else if (item.type === "Video") {
      const v = el as HTMLVideoElement
      const reasons = []
      if (v.autoplay && !v.muted) reasons.push("autoplay without muted")
      if (!v.poster)              reasons.push("missing poster attribute")
      detail = reasons.join(", ")
    } else if (item.type === "IFrame") {
      detail = `src="${(el as HTMLIFrameElement).src || "unknown"}" — missing loading="lazy"`
    } else if (item.type === "Text") {
      const text = el.innerText?.slice(0, 120).replace(/\s+/g, " ").trim()
      detail = `${el.innerText?.length} chars — "${text}…"`
    } else if (item.type === "Listener") {
      detail = `data-sentinel-bloat set — >15 expensive listeners on this element`
    }

    const fixText = {
      Image:    'Add loading="lazy" decoding="async" and explicit width/height',
      Video:    'Add muted attribute and a poster image',
      IFrame:   'Add loading="lazy" to defer off-screen iframe load',
      Text:     'Break into smaller chunks or use CSS content-visibility',
      Listener: 'Throttle or debounce scroll/mousemove handlers on this element',
    }[item.type]

    console.groupCollapsed(
      `%c  [#${i + 1}] ${item.type.toUpperCase()}%c  ${selector}`,
      "color:#ff4455; font-weight:bold;",
      "color:#aaa; font-weight:normal;"
    )
    console.log("%cElement:", "color:#888;", el)
    console.log("%cDetail: ", "color:#888;", detail)
    console.log("%cFix:    ", "color:#888;", fixText)
    console.groupEnd()
  })
  
  console.groupEnd()

  // Scroll to the first culprit so the user can see it immediately
  setTimeout(() => culprits[0].el.scrollIntoView({ behavior: "smooth", block: "center" }), 120)

  return { found: culprits.length, counts, firstType: culprits[0].type }
}

// ── NAVIGATE_FUNC ─────────────────────────────────────────────────────────────
// Equivalent to NAVIGATE_FUNC in sidepanel.js.
// Also injected into the page. Finds the element by its data-sentinel-idx,
// restarts its pulse animation, and smoothly scrolls it into view.
// void el.offsetWidth forces a reflow to restart the CSS animation.
const NAVIGATE_FUNC = (targetIdx: number) => {
  const el = document.querySelector(`[data-sentinel-idx="${targetIdx}"]`) as HTMLElement | null
  if (!el) return { ok: false, idx: 0, type: "" }

  el.classList.remove("__sentinel-culprit")
  void el.offsetWidth   // force reflow — restarts the pulse animation
  el.classList.add("__sentinel-culprit")
  setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 120)

  return { ok: true, idx: targetIdx, type: el.dataset.sentinelType || "" }
}

// ── TooltipBox component ──────────────────────────────────────────────────────
// Equivalent to the innerHTML template string built inside the info-icon click
// handler in sidepanel.js. In React we render it as a proper component instead
// of injecting raw HTML strings.
// Shown when the user clicks an (i) icon next to any metric label.
function TooltipBox({ metric }: { metric: string }) {
  const info = METRIC_INFO[metric]
  if (!info) return null
  return (
    // .metric-tooltip.open from sidepanel.html CSS
    <div style={{ background: "#12121c", border: "1px solid #38bdf840", borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 4, fontSize: 10, color: "#ccc", lineHeight: 1.5, boxShadow: "0 8px 20px rgba(0,0,0,0.8), 0 0 15px rgba(56,189,248,0.1)", width: "100%", animation: "slideDownFade 0.25s cubic-bezier(0.16,1,0.3,1)" }}>
      {/* Header row: metric key left, full name right */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8, borderBottom: "1px solid #38bdf840", paddingBottom: 6 }}>
        <span style={{ fontWeight: 800, color: "#fff", fontSize: 11, letterSpacing: 0.5 }}>{metric} Diagnostic</span>
        <span style={{ fontSize: 9, color: "#38bdf8", textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.8, textAlign: "right", maxWidth: "50%", wordWrap: "break-word" }}>{info.full}</span>
      </div>
      {/* Description */}
      <div style={{ fontSize: 11, color: "#ccc", lineHeight: 1.4, marginBottom: 10 }}>{info.desc}</div>
      {/* Standard + Fix rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11, background: "#1a1a26", padding: 10, borderRadius: 6, border: "1px solid #2a2a3a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "#888" }}>Standard:</span>
          <span style={{ color: "#00ff88", fontFamily: "'Courier New', monospace", fontWeight: 600, fontSize: 11.5 }}>{info.goal}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 4 }}>
          <span style={{ color: "#888", marginRight: 8 }}>Fix:</span>
          <span style={{ color: "#eee", textAlign: "right", maxWidth: "80%", lineHeight: 1.4, fontSize: 11 }}>{info.fix}</span>
        </div>
      </div>
    </div>
  )
}

// ── InfoIcon component ────────────────────────────────────────────────────────
// Equivalent to the .info-icon <span> elements in sidepanel.html +
// the querySelectorAll('.info-icon') click handler in sidepanel.js.
// Clicking toggles the tooltip for this metric; clicking any other icon or
// the page background closes all tooltips (handled by the parent via activeTooltip state).
function InfoIcon({ metric, activeTooltip, onToggle }: {
  metric:        string
  activeTooltip: string | null
  onToggle:      (m: string | null) => void
}) {
  const isActive = activeTooltip === metric
  return (
    <span
      onClick={(e) => {
        e.stopPropagation()  // prevent the document click handler from immediately closing it
        onToggle(isActive ? null : metric)
      }}
      title={`${metric} info`}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 14, height: 14, borderRadius: "50%",
        background:  isActive ? "#38bdf8" : "#1a1a26",
        color:       isActive ? "#000"    : "#38bdf8",
        fontSize: 9, fontWeight: 700, cursor: "pointer",
        marginLeft: 6, verticalAlign: "middle",
        border: `1px solid ${isActive ? "#38bdf8" : "rgba(56,189,248,0.3)"}`,
        boxShadow: isActive ? "0 0 10px rgba(56,189,248,0.4)" : "0 0 4px rgba(56,189,248,0.1)",
        transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
      }}>
      i
    </span>
  )
}

// ── SidePanel — main component ────────────────────────────────────────────────
export default function SidePanel() {

  // ── State — equivalent to the let variables at the top of sidepanel.js ──────
  const [stats,         setStats]         = useState<LiveStats>({ memory: null, nodes: 0, depth: 0 })
  const [longTaskCount, setLongTaskCount] = useState(0)
  const [vitals,        setVitals]        = useState<Record<string, string>>({})
  const [hints,         setHints]         = useState<Hint[]>([])
  const [seoStats,      setSeoStats]      = useState<SeoStats | null>(null)
  const [redirects,     setRedirects]     = useState<Hop[]>([])
  const [listenerTotal, setListenerTotal] = useState(0)
  const [trackerActive, setTrackerActive] = useState(false)

  // activeTooltip: which (i) icon's tooltip is currently open (null = all closed)
  // Equivalent to the classList.add/remove('active') + classList.add/remove('open') logic
  const [activeTooltip,   setActiveTooltip]   = useState<string | null>(null)

  // culpritInfoOpen: whether the collapsible ℹ panel inside the culprit card is open
  // Equivalent to infoPanel.classList.toggle('open') in sidepanel.js
  const [culpritInfoOpen, setCulpritInfoOpen] = useState(false)

  // culpritStatus: the text shown below the Find Culprits button
  const [culpritStatus,   setCulpritStatus]   = useState("Press to locate & scroll to flagged elements")

  // culpritTotal / culpritIdx: shared state for ▲▼ navigation
  // Equivalent to let culpritTotal = 0; let culpritIdx = 0; in sidepanel.js
  const [culpritTotal, setCulpritTotal] = useState(0)
  const [culpritIdx,   setCulpritIdx]   = useState(0)
  const [scanning,     setScanning]     = useState(false)

  // Ref to the Long Tasks value element — used to flash it red on each new task
  // Equivalent to classList.add('alert-pulse') in sidepanel.js
  const taskValRef = useRef<HTMLDivElement>(null)

  const checkAdvancedIndexability = (url: string) => {
    chrome.runtime.sendMessage({ type: "CHECK_INDEXABILITY", url }, (res) => {
      if (res?.success) {
        setSeoStats((prev) => {
          if (!prev) return prev
          const isNoindexMeta = prev.robots.toLowerCase().includes("noindex")
          const isNoindexX = res.xRobotsTag.toLowerCase().includes("noindex")
          let indexableStatus = "✅ Indexable"
          if (res.isBlockedByRobotsTxt) indexableStatus = "❌ Blocked (robots.txt)"
          else if (isNoindexMeta) indexableStatus = "❌ Blocked (meta robots)"
          else if (isNoindexX) indexableStatus = "❌ Blocked (x-robots-tag)"

          return { ...prev, xRobotsTag: res.xRobotsTag, robotsTxtBlocked: res.isBlockedByRobotsTxt, indexableStatus }
        })
      }
    })
  }

  // ── Tab change — reset all metrics when user switches tabs ──────────────────
  // Listens for TAB_ACTIVATED messages sent by content.tsx on visibilitychange
  // instead of chrome.tabs.onActivated — avoids needing the tabs permission.
  useEffect(() => {
    const onTabActivated = (msg: any) => {
      if (msg.type !== "TAB_ACTIVATED") return
      setVitals({})
      setLongTaskCount(0)
      setHints([])
      setSeoStats(null)
      setRedirects([])
      setListenerTotal(0)
      setTrackerActive(false)
      setCulpritTotal(0)
      setCulpritIdx(0)
      setCulpritStatus("Press to locate & scroll to flagged elements")
      setTimeout(fetchVitalsFromTab, 100)
    }
    chrome.runtime.onMessage.addListener(onTabActivated)
    return () => chrome.runtime.onMessage.removeListener(onTabActivated)
  }, [])

  // ── getActiveTabId ────────────────────────────────────────────────────────────
  // Replaces chrome.tabs.query({ active: true, currentWindow: true }) which
  // requires the tabs permission. Instead asks the background for the tab ID
  // it stored when the user clicked the toolbar icon — no tabs permission needed.
  const getActiveTabId = (): Promise<number | null> =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB_ID" }, (res) => {
        resolve(res?.tabId ?? null)
      })
    })

  // ── Fetch vitals already recorded in the performance timeline ────────────────
  // When the sidepanel opens after page load, PerformanceObserver events have
  // already fired and won't fire again. This reads the timeline directly from
  // the tab so metrics appear immediately without a page reload.
  const fetchVitalsFromTab = async () => {
    const tabId = await getActiveTabId()
    if (!tabId) return

    // Immediately fetch redirect trace
    chrome.runtime.sendMessage({ type: "GET_REDIRECT_TRACE", tabId }, (res) => {
      if (res?.success) setRedirects(res.trace)
    })

    // Read persisted INP, listener total, long task count from storage
    chrome.storage.session.get("sentinelTabData").then((store) => {
      const tabData = store.sentinelTabData || {}
      chrome.scripting.executeScript(
        { target: { tabId: tabId }, func: () => location.href },
        (res) => {
          if (chrome.runtime.lastError || !res?.[0]?.result) return
          const key = res[0].result as string
          const saved = tabData[key] || {}
          if (saved.INP)           setVitals((v) => ({ ...v, INP: saved.INP }))
          if (saved.listenerTotal !== undefined) {
            setListenerTotal(saved.listenerTotal)
            setTrackerActive(true)
          }
          if (saved.longTaskCount) setLongTaskCount(saved.longTaskCount)
        }
      )
    })

    // Read performance timeline entries directly from the tab
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        func: () => {
          const result: Record<string, string> = {}

          // FCP
          const fcp = performance.getEntriesByName("first-contentful-paint")[0]
          if (fcp) result.FCP = `${Math.round(fcp.startTime)}ms`

          // LCP — last entry wins (spec says use the final candidate)
          const lcpEntries = performance.getEntriesByType("largest-contentful-paint")
          if (lcpEntries.length) {
            const lcp = lcpEntries[lcpEntries.length - 1]
            result.LCP = `${Math.round(lcp.startTime)}ms`
            // Speed Index heuristic: FCP + 0.8 * (LCP - FCP)
            const fcpVal = fcp?.startTime ?? 0
            const si = fcpVal + (lcp.startTime - fcpVal) * 0.8
            result.SI = `${Math.round(si)}ms`
          }

          // CLS — accumulate all layout-shift entries
          let cls = 0
          performance.getEntriesByType("layout-shift").forEach((e: any) => {
            if (!e.hadRecentInput) cls += e.value
          })
          if (cls > 0) result.CLS = cls.toFixed(4)

          // TBT — sum of (duration - 50) for all longtask entries
          let tbt = 0
          performance.getEntriesByType("longtask").forEach((e) => {
            tbt += e.duration - 50
          })
          if (tbt > 0) result.TBT = `${Math.round(tbt)}ms`

          // FID — first-input entries
          const fidEntries = performance.getEntriesByType("first-input")
          if (fidEntries.length) {
            const fi = fidEntries[0] as any
            const delay = fi.processingStart - fi.startTime
            result.FID = `${Math.round(delay)}ms`
          }

          // Font Load Time — slowest font/css resource responseEnd
          let maxFlt = 0
          performance.getEntriesByType("resource").forEach((e: any) => {
            if (
              e.initiatorType === "css" ||
              e.initiatorType === "font" ||
              e.name.match(/\.(woff2|woff|ttf|otf)/i)
            ) {
              if (e.responseEnd > maxFlt) maxFlt = e.responseEnd
            }
          })
          if (maxFlt > 0) result.FLT = `${Math.round(maxFlt)}ms`

          // Network hints
          const hints = Array.from(
            document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]')
          ).map((l) => ({ rel: (l as HTMLLinkElement).rel, href: (l as HTMLLinkElement).href }))

          // SEO
          const title = document.title || ""
          const description = document.querySelector('meta[name="description"]')?.getAttribute("content") || ""
          const h1Count = document.querySelectorAll("h1").length
          const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || ""
          const robots = document.querySelector('meta[name="robots"]')?.getAttribute("content") || ""
          const images = Array.from(document.querySelectorAll("img"))
          const imagesTotal = images.length
          const imagesMissingAlt = images.filter((img) => !img.hasAttribute("alt") || img.getAttribute("alt")?.trim() === "").length
          const seoStats = { title, description, h1Count, canonical, robots, imagesTotal, imagesMissingAlt }

          return { vitals: result, hints, seoStats, location: window.location.href }
        }
      },
      (results) => {
        if (chrome.runtime.lastError || !results?.[0]?.result) return
        const { vitals: v, hints: h, seoStats: s, location: loc } = results[0].result as any
        if (v && Object.keys(v).length) setVitals((prev) => ({ ...prev, ...v }))
        if (h) setHints(h)
        if (s) {
          setSeoStats(s)
          if (loc) checkAdvancedIndexability(loc)
        }
      }
    )
  }

  // ── chrome.runtime.onMessage listener ────────────────────────────────────────
  // Equivalent to the chrome.runtime.onMessage.addListener block in sidepanel.js.
  // Routes incoming messages from content.tsx by type.
  useEffect(() => {
    const handler = (msg: any) => {

      if (msg.type === "LONG_TASK") {
        // Increment counter and briefly flash it red
        setLongTaskCount((c) => c + 1)
        if (taskValRef.current) {
          taskValRef.current.style.color = "#ff4455"
          setTimeout(() => {
            if (taskValRef.current) taskValRef.current.style.color = "#ffaa00"
          }, 600)
        }

      } else if (msg.type === "VITALS_UPDATE") {
        // Store the new value — color is computed at render time via vitalColor()
        setVitals((v) => ({ ...v, [msg.metric]: msg.value }))

      } else if (msg.type === "HINTS_UPDATE") {
        // Replace the hints list with whatever the page currently has
        setHints(msg.hints ?? [])

      } else if (msg.type === "SEO_UPDATE") {
        setSeoStats(msg.seoStats)
        if (msg.location) checkAdvancedIndexability(msg.location)

      } else if (msg.type === "LISTENER_UPDATE") {
        // First message from tracker.ts — mark tracker as active
        // Equivalent to the trackerBadge 'Initializing' → '✅ Tracker: Active' logic
        setTrackerActive(true)
        setListenerTotal(msg.total)
      }
    }

    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  // ── Live stats polling ────────────────────────────────────────────────────────
  useEffect(() => {
    // Fetch vitals immediately on mount — page may have already loaded
    fetchVitalsFromTab()

    const updateUI = async () => {
      const tabId = await getActiveTabId()
      if (!tabId) return

      chrome.scripting.executeScript(
        {
          target: { tabId: tabId },
          func: () => {
            // Iterative depth traversal — safe for deeply nested pages
            let maxDepth = 0
            const stack: [Element, number][] = [[document.documentElement, 1]]
            while (stack.length) {
              const [node, depth] = stack.pop()!
              maxDepth = Math.max(maxDepth, depth)
              for (const child of node.children) stack.push([child, depth + 1])
            }
            return {
              memory: (performance as any).memory
                ? ((performance as any).memory.usedJSHeapSize / 1048576).toFixed(2)
                : null,
              nodes: document.querySelectorAll("*").length,
              depth: maxDepth
            }
          }
        },
        (results) => {
          if (chrome.runtime.lastError || !results?.[0]) return
          setStats(results[0].result as LiveStats)
        }
      )
    }

    updateUI()
    const id = setInterval(updateUI, 1000)
    return () => clearInterval(id)
  }, [])

  // ── findCulprits ──────────────────────────────────────────────────────────────
  // Equivalent to the 'find-culprits' click handler in sidepanel.js.
  // Focuses the tab, injects SCAN_FUNC, then updates state with the results.
  const findCulprits = async () => {
    const tabId = await getActiveTabId()
    if (!tabId) return

    setScanning(true)
    setCulpritStatus("Searching for performance bottlenecks…")
    setCulpritTotal(0)

    chrome.scripting.executeScript(
      { target: { tabId }, func: SCAN_FUNC },
      (results) => {
        setScanning(false)

        if (chrome.runtime.lastError || !results?.[0]) {
          setCulpritStatus("⚠️ Cannot run on this page")
          return
        }

        const { found, counts, firstType } = results[0].result as ScanResult
        setCulpritTotal(found)
        setCulpritIdx(0)

        if (found === 0) {
          setCulpritStatus("No culprits found — page looks clean ✅")
        } else {
          // Build the "2 Images, 1 Video" summary string
          const types = Object.entries(counts)
            .filter(([, c]) => c > 0)
            .map(([t, c]) => `${c} ${t}${c > 1 ? "s" : ""}`)
            .join(", ")
          setCulpritStatus(`#1 ${firstType} · Found ${types}`)
        }
      }
    )
  }

  // ── navigate ──────────────────────────────────────────────────────────────────
  // Equivalent to prevBtn and nextBtn click handlers in sidepanel.js.
  // Injects NAVIGATE_FUNC with the target index, then updates culpritIdx + status.
  const navigate = async (dir: "prev" | "next") => {
    const tabId = await getActiveTabId()
    if (!tabId) return

    const targetIdx = dir === "prev" ? culpritIdx - 1 : culpritIdx + 1

    chrome.scripting.executeScript(
      { target: { tabId }, func: NAVIGATE_FUNC, args: [targetIdx] },
      (results) => {
        const res = results?.[0]?.result as NavResult
        if (res?.ok) {
          setCulpritIdx(targetIdx)
          setCulpritStatus(`#${targetIdx + 1} ${res.type} · viewing culprit`)
        }
      }
    )
  }

  // Derived values for listener pressure section
  // Equivalent to the if/else color + text logic in the LISTENER_UPDATE handler
  const listenerColor  = listenerTotal < 15 ? "#00ff88" : listenerTotal < 30 ? "#ffaa00" : "#ff4455"
  const listenerStatus = listenerTotal < 15 ? "Healthy"  : listenerTotal < 30 ? "Warning"  : "Bloated"

  // Helper to toggle a tooltip — closes all others first (same as sidepanel.js)
  const toggleTooltip = (metric: string | null) =>
    setActiveTooltip((prev) => (prev === metric ? null : metric))

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    // Clicking the page background closes all open tooltips
    // Equivalent to document.addEventListener('click', ...) in sidepanel.js
    <div
      onClick={() => setActiveTooltip(null)}
      style={{ width: "100%", minHeight: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#0f0f13", color: "#e0e0e0", padding: "18px 16px", boxSizing: "border-box" }}>

      {/* All CSS classes from sidepanel.html injected as a <style> tag.
          This preserves every animation, hover state, and transition exactly. */}
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes pulse         { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes slideDownFade { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes flash         { 0%,100%{opacity:1} 50%{opacity:0.5} }
        .stat-card               { background:#1a1a26; border:1px solid #2a2a3a; border-radius:10px; padding:12px 14px; transition:border-color 0.2s; }
        .stat-card:hover         { border-color:#00ff8860; }
        .diag-card               { background:#1a1a26; border:1px solid #2a2a3a; border-radius:10px; padding:12px 14px; margin-bottom:20px; }
        .diag-row                { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05); }
        .diag-row:last-child     { border-bottom:none; }
        .diag-label              { font-size:11px; color:#888; }
        .diag-value              { font-size:12px; font-weight:600; font-family:'Courier New',monospace; text-align:right; }
        .vital-item              { display:flex; flex-direction:column; gap:2px; width:100%; }
        .vital-item .diag-label  { display:flex; justify-content:space-between; align-items:center; width:100%; }
        .nav-btn                 { width:28px; height:22px; background:#12121c; border:1px solid #2a2a3a; border-radius:5px; color:#888; font-size:11px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.18s; }
        .nav-btn:hover:not(:disabled) { border-color:#ff445580; color:#ff4455; background:#ff445510; }
        .nav-btn:disabled        { opacity:0.25; cursor:not-allowed; }
        .fix-tag-easy            { background:#00ff8822; color:#00ff88; border:1px solid #00ff8840; display:inline-block; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; margin-right:4px; vertical-align:middle; }
        .fix-tag-med             { background:#ffaa0022; color:#ffaa00; border:1px solid #ffaa0040; display:inline-block; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; margin-right:4px; vertical-align:middle; }
        button                   { font-family:inherit; }
      `}</style>

      {/* ── Header ── */}
      {/* Equivalent to <header> in sidepanel.html */}
      <header style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20, borderBottom:"1px solid #2a2a3a", paddingBottom:12 }}>
        {/* Pulsing green dot — .dot with @keyframes pulse */}
        <div style={{ width:10, height:10, borderRadius:"50%", background:"#00ff88", boxShadow:"0 0 8px #00ff88aa", animation:"pulse 2s infinite" }} />
        <h1 style={{ fontSize:15, fontWeight:600, color:"#00ff88", letterSpacing:0.5 }}>DOM-Scout</h1>
        <span style={{ marginLeft:"auto", fontSize:11, color:"#555" }}>Live</span>
      </header>

      {/* ── Stats Grid ── */}
      {/* Equivalent to .stats-grid in sidepanel.html — 2-column grid of stat cards */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:20 }}>

        {/* JS Heap card */}
        <div className="stat-card">
          <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
            JS Heap
            <InfoIcon metric="HEAP" activeTooltip={activeTooltip} onToggle={toggleTooltip} />
          </div>
          <div style={{ fontSize:22, fontWeight:700, fontFamily:"'Courier New',monospace", color:"#00ff88" }}>
            {stats.memory ?? "—"}<span style={{ fontSize:12, color:"#555", marginLeft:3 }}>MB</span>
          </div>
          {activeTooltip === "HEAP" && <TooltipBox metric="HEAP" />}
        </div>

        {/* DOM Nodes card */}
        <div className="stat-card">
          <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
            DOM Nodes
            <InfoIcon metric="NODES" activeTooltip={activeTooltip} onToggle={toggleTooltip} />
          </div>
          <div style={{ fontSize:22, fontWeight:700, fontFamily:"'Courier New',monospace", color:"#00ff88" }}>
            {stats.nodes || "—"}
          </div>
          {activeTooltip === "NODES" && <TooltipBox metric="NODES" />}
        </div>

        {/* DOM Depth card */}
        <div className="stat-card">
          <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
            DOM Depth
            <InfoIcon metric="DEPTH" activeTooltip={activeTooltip} onToggle={toggleTooltip} />
          </div>
          <div style={{ fontSize:22, fontWeight:700, fontFamily:"'Courier New',monospace", color:"#00ff88" }}>
            {stats.depth || "—"}
          </div>
          {activeTooltip === "DEPTH" && <TooltipBox metric="DEPTH" />}
        </div>

        {/* Long Tasks card — .stat-card.warn, value flashes red on each new task */}
        <div className="stat-card" style={{ borderColor:"#ffaa0030" }}>
          <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
            Long Tasks
            <InfoIcon metric="TBT" activeTooltip={activeTooltip} onToggle={toggleTooltip} />
          </div>
          <div ref={taskValRef} style={{ fontSize:22, fontWeight:700, fontFamily:"'Courier New',monospace", color:"#ffaa00", transition:"color 0.3s" }}>
            {longTaskCount}
          </div>
          {activeTooltip === "TBT" && <TooltipBox metric="TBT" />}
        </div>
      </div>

      {/* ── Culprit Finder card ── */}
      {/* Equivalent to .culprit-card in sidepanel.html */}
      <div style={{ background:"#1a1a26", border:"1px solid #ff445530", borderRadius:10, padding:"12px 14px", marginBottom:20 }}>

        {/* .culprit-row — Find button + ▲▼ nav + counter + ℹ button */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>

          {/* Find Culprits button */}
          <button
            onClick={findCulprits}
            disabled={scanning}
            style={{ padding:"7px 12px", background:"#12121c", border:"1px solid #ff4455", borderRadius:7, color:"#ff4455", fontSize:12, fontWeight:600, cursor:scanning ? "not-allowed" : "pointer", opacity:scanning ? 0.6 : 1, whiteSpace:"nowrap", transition:"all 0.2s" }}>
            {scanning ? "🔍 Scanning…" : "🎯 Find Culprits"}
          </button>

          {/* ▲▼ navigation — .culprit-nav */}
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <button className="nav-btn" disabled={culpritIdx <= 0 || culpritTotal === 0}
              onClick={() => navigate("prev")} title="Previous culprit">▲</button>
            <button className="nav-btn" disabled={culpritIdx >= culpritTotal - 1 || culpritTotal === 0}
              onClick={() => navigate("next")} title="Next culprit">▼</button>
          </div>

          {/* N / Total counter badge — hidden until culprits are found */}
          {culpritTotal > 0 && (
            <span style={{ fontSize:12, fontWeight:700, fontFamily:"'Courier New',monospace", color:"#ff4455", minWidth:44, textAlign:"center" }}>
              {culpritIdx + 1} / {culpritTotal}
            </span>
          )}

          {/* ℹ info button — toggles the collapsible info panel */}
          <button
            onClick={(e) => { e.stopPropagation(); setCulpritInfoOpen((v) => !v) }}
            title={culpritInfoOpen ? "Hide info" : "Why are these culprits? What are the fixes?"}
            style={{ marginLeft:"auto", width:22, height:22, borderRadius:"50%", background:"#12121c", border:`1px solid ${culpritInfoOpen ? "#38bdf8" : "#38bdf860"}`, color:"#38bdf8", fontSize:11, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, transition:"all 0.2s" }}>
            ℹ
          </button>
        </div>

        {/* Status text row — .culprit-status-row */}
        <div style={{ marginTop:9, borderTop:"1px solid #1e1e2e", paddingTop:8, fontSize:11, color: culpritTotal > 0 ? "#ff4455" : "#444", transition:"color 0.3s", lineHeight:1.6 }}>
          {culpritStatus}
        </div>

        {/* Collapsible info panel — .culprit-info-panel
            Uses max-height transition trick: animates from 0 → 400px.
            Can't animate height:auto in CSS, but max-height works. */}
        <div style={{ overflow:"hidden", maxHeight: culpritInfoOpen ? 400 : 0, opacity: culpritInfoOpen ? 1 : 0, marginTop: culpritInfoOpen ? 10 : 0, transition:"max-height 0.35s ease, opacity 0.3s ease, margin-top 0.3s" }}>
          <hr style={{ border:"none", borderTop:"1px solid #2a2a3a", marginBottom:10 }} />

          {/* Why are they culprits? */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:0.8, color:"#555", marginBottom:5 }}>🔍 Why are they culprits?</div>
            <div style={{ fontSize:11, color:"#aaa", lineHeight:1.6 }}>
              <strong style={{ color:"#eee" }}>Images &amp; Videos:</strong> Large files block the browser's Main Thread during decode.<br />
              <strong style={{ color:"#eee" }}>Text:</strong> Large blocks cause Layout Shifts (CLS) or delay LCP.<br />
              <strong style={{ color:"#eee" }}>Listeners:</strong> Too many "expensive" listeners (scroll, mousemove) on a single element create <em>Active Listener Pressure</em>, causing lag during user interaction.
            </div>
          </div>

          {/* Recommended fixes */}
          <div>
            <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:0.8, color:"#555", marginBottom:5 }}>✅ Recommended fixes</div>
            <ul style={{ listStyle:"none", padding:0, margin:0, display:"flex", flexDirection:"column", gap:5 }}>
              {[
                { tag:"IMAGE",  cls:"fix-tag-easy", fix: <>Add <code style={{ color:"#00ff88", fontFamily:"'Courier New',monospace", fontSize:10, background:"#00ff8812", padding:"1px 4px", borderRadius:3 }}>loading="lazy"</code> and <code style={{ color:"#00ff88", fontFamily:"'Courier New',monospace", fontSize:10, background:"#00ff8812", padding:"1px 4px", borderRadius:3 }}>decoding="async"</code></> },
                { tag:"VIDEO",  cls:"fix-tag-easy", fix: <>Add <code style={{ color:"#00ff88", fontFamily:"'Courier New',monospace", fontSize:10, background:"#00ff8812", padding:"1px 4px", borderRadius:3 }}>muted</code> and a <code style={{ color:"#00ff88", fontFamily:"'Courier New',monospace", fontSize:10, background:"#00ff8812", padding:"1px 4px", borderRadius:3 }}>poster</code></> },
                { tag:"TEXT",   cls:"fix-tag-med",  fix: <>Use <code style={{ color:"#00ff88", fontFamily:"'Courier New',monospace", fontSize:10, background:"#00ff8812", padding:"1px 4px", borderRadius:3 }}>font-display: swap</code></> },
                { tag:"LISTEN", cls:"fix-tag-med",  fix: <>Use Throttling or Debouncing for scroll/mousemove</> },
              ].map(({ tag, cls, fix }) => (
                <li key={tag} style={{ fontSize:10.5, background:"#12121c", border:"1px solid #2a2a3a", borderRadius:6, padding:"6px 8px", color:"#ccc", lineHeight:1.5 }}>
                  <span className={cls}>{tag}</span>{fix}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ── Core Web Vitals card ── */}
      {/* Equivalent to the .diag-card with id="vital-*" elements in sidepanel.html */}
      <div className="diag-card">
        <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:10 }}>⚡ Core Web Vitals</div>

        {/* Each vital row — .diag-row > .vital-item */}
        {[
          { key:"CLS",       label:"CLS",         sub:"Jumpy Page" },
          { key:"FCP",       label:"FCP",         sub:"First Cont. Paint" },
          { key:"LCP",       label:"LCP",         sub:"Waiting Game" },
          { key:"SI",        label:"SI",          sub:"Speed Index Approx" },
          { key:"FLT",       label:"Font Load",   sub:"Invisible Text" },
          { key:"INP",       label:"INP",         sub:"Interact. to Next Paint" },
          { key:"FID",       label:"Input Delay", sub:"Sticky Button" },
          { key:"TBT",       label:"TBT",         sub:"Engine Stall" },
        ].map(({ key, label, sub }) => (
          <div key={key} className="diag-row">
            <div className="vital-item">
              <div className="diag-label">
                <span>
                  {label} <small style={{ fontSize:"0.75rem", opacity:0.5, fontWeight:"normal", marginLeft:8, color:"#888" }}>({sub})</small>
                  <InfoIcon metric={key} activeTooltip={activeTooltip} onToggle={toggleTooltip} />
                </span>
                {/* Color-coded value — green/yellow/red via vitalColor() */}
                <span className="diag-value" style={{ color: vitals[key] ? vitalColor(key, vitals[key]) : "#555" }}>
                  {vitals[key] || "—"}
                </span>
              </div>
              {activeTooltip === key && <TooltipBox metric={key} />}
            </div>
          </div>
        ))}
      </div>

      {/* ── Network Optimization card ── */}
      {/* Equivalent to the Network Optimization .diag-card in sidepanel.html */}
      <div className="diag-card">
        <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:10 }}>
          🌐 Network Optimization
          <InfoIcon metric="NETWORK" activeTooltip={activeTooltip} onToggle={toggleTooltip} />
        </div>
        {activeTooltip === "NETWORK" && <TooltipBox metric="NETWORK" />}

        <div className="diag-row">
          <span className="diag-label">Preconnect / DNS-prefetch</span>
        </div>

        {/* Hints list — equivalent to #hints-list in sidepanel.html
            Populated by the HINTS_UPDATE message from content.tsx */}
        <ul style={{ margin:0, padding:0, listStyle:"none", fontSize:10, color:"#888", borderTop:"1px solid rgba(255,255,255,0.05)", paddingTop:8 }}>
          {hints.length === 0
            ? <li style={{ fontStyle:"italic", opacity:0.5 }}>No hints detected yet…</li>
            : hints.map((h, i) => (
              <li key={i} style={{ marginBottom:4, wordBreak:"break-all" }}>
                <span style={{ color:"#00ff88", fontWeight:"bold", marginRight:4 }}>{h.rel.toUpperCase()}:</span>
                {h.href}
              </li>
            ))}
        </ul>
      </div>

      {/* ── Listener Pressure card ── */}
      {/* Equivalent to the Listener Pressure .diag-card in sidepanel.html */}
      <div className="diag-card">
        {/* Header row with tracker status badge */}
        <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          🛑 Listener Pressure
          {/* Tracker status badge — 'Initializing' until first LISTENER_UPDATE arrives */}
          <span style={{ fontSize:9, padding:"2px 6px", borderRadius:4, background: trackerActive ? "rgba(0,255,136,0.1)" : "rgba(255,255,255,0.05)", color: trackerActive ? "#00ff88" : "#888", transition:"all 0.3s" }}>
            {trackerActive ? "✅ Tracker: Active" : "Tracker: Initializing"}
          </span>
        </div>

        {/* Active Pressure row */}
        <div className="diag-row">
          <span className="diag-label">
            Active Pressure
            <InfoIcon metric="PRESSURE" activeTooltip={activeTooltip} onToggle={toggleTooltip} />
          </span>
          <span className="diag-value" style={{ color: listenerColor }}>{listenerTotal}</span>
        </div>
        {activeTooltip === "PRESSURE" && <TooltipBox metric="PRESSURE" />}

        {/* Status row — Healthy / Warning / Bloated */}
        <div className="diag-row">
          <span className="diag-label">Status</span>
          <span className="diag-value" style={{ color: listenerColor }}>{listenerStatus}</span>
        </div>
      </div>

      {/* ── SEO Diagnostics card ── */}
      <div className="diag-card">
        <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:10 }}>
          🔍 SEO Diagnostics
        </div>

        {!seoStats ? (
          <div style={{ fontSize:10, fontStyle:"italic", color:"#888", padding: "8px 0" }}>Scanning SEO properties...</div>
        ) : (
          <>
            <div className="diag-row">
              <span className="diag-label">Title Tag</span>
              <span className="diag-value" style={{ color: (seoStats.title.length >= 10 && seoStats.title.length <= 60) ? "#00ff88" : seoStats.title.length > 60 ? "#ffaa00" : "#ff4455", maxWidth: "60%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={seoStats.title}>
                {seoStats.title ? `${seoStats.title.length} chars` : "Missing"}
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">Meta Descr</span>
              <span className="diag-value" style={{ color: (seoStats.description.length >= 50 && seoStats.description.length <= 160) ? "#00ff88" : seoStats.description.length > 160 ? "#ffaa00" : "#ff4455", maxWidth: "60%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={seoStats.description}>
                {seoStats.description ? `${seoStats.description.length} chars` : "Missing"}
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">H1 Element</span>
              <span className="diag-value" style={{ color: seoStats.h1Count === 1 ? "#00ff88" : seoStats.h1Count === 0 ? "#ff4455" : "#ffaa00" }}>
                {seoStats.h1Count} found
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">Canonical URL</span>
              <span className="diag-value" style={{ color: seoStats.canonical ? "#00ff88" : "#888", maxWidth: "60%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={seoStats.canonical}>
                {seoStats.canonical ? "Present" : "Missing"}
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">Robots Meta</span>
              <span className="diag-value" style={{ color: seoStats.robots ? "#00ff88" : "#888" }}>
                {seoStats.robots || "Not Set"}
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">X-Robots-Tag</span>
              <span className="diag-value" style={{ color: seoStats.xRobotsTag ? "#00ff88" : "#888" }}>
                {seoStats.xRobotsTag === undefined ? "Checking..." : (seoStats.xRobotsTag || "Not Set")}
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">Indexability Status</span>
              <span className="diag-value" style={{ color: seoStats.indexableStatus && seoStats.indexableStatus.startsWith("✅") ? "#00ff88" : seoStats.indexableStatus ? "#ff4455" : "#ffaa00", fontWeight: "bold" }}>
                {seoStats.indexableStatus || "Checking constraints..."}
              </span>
            </div>
            <div className="diag-row">
              <span className="diag-label">Missing Alt Text</span>
              <span className="diag-value" style={{ color: seoStats.imagesMissingAlt === 0 ? "#00ff88" : seoStats.imagesTotal > 0 && (seoStats.imagesMissingAlt / seoStats.imagesTotal > 0.5) ? "#ff4455" : "#ffaa00" }}>
                {seoStats.imagesMissingAlt} / {seoStats.imagesTotal} images
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Link Redirect Trace card ── */}
      <div className="diag-card">
        <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.8, marginBottom:10 }}>
          🔀 Link Redirect Trace
        </div>

        {redirects.length === 0 ? (
          <div style={{ fontSize:10, fontStyle:"italic", color:"#888", padding: "8px 0" }}>No redirects detected (Direct 200 OK)</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {redirects.map((hop, idx) => (
              <div key={idx} className="diag-row" style={{ display: "flex", alignItems: "center", borderBottom: idx === redirects.length - 1 ? "none" : "1px solid #e0e0e0" }}>
                <span style={{ 
                  display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: "bold", backgroundColor: hop.statusCode < 300 ? "#00ff8844" : hop.statusCode < 400 ? "#ffaa0044" : "#ff445544", color: hop.statusCode < 300 ? "#008844" : hop.statusCode < 400 ? "#cc7700" : "#cc2233"
                }}>
                  {hop.statusCode}
                </span>
                <span className="diag-value" style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 10, color: "#444" }} title={hop.url}>
                  {hop.url}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer style={{ marginTop:20, fontSize:10, color:"#333", textAlign:"center" }}>
        DOM-Scout · DOM × Hardware Correlation
      </footer>
    </div>
  )
}
