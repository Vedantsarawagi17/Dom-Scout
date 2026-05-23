// content.tsx => Can see DOM(Document Object Model) but not JS (Javascript)
// ─────────────────────────────────────────────────────────────────────────────
// content.tsx — Plasmo Content Script
//
// Content scripts run in an ISOLATED WORLD — they can see the DOM but NOT the
// page's own JS variables. This file bridges the page world and the extension world.
//
// Plasmo auto-injects this file into every page because of the exported `config`
// below. No manifest.json entry needed.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { PlasmoCSConfig } from "plasmo"

type LargestContentfulPaintEntry = PerformanceEntry & {
  element?: HTMLElement | null
}

// Plasmo's CSUI wrapper always tries to render a default export from content.tsx.
// Without one it gets undefined and React crashes with "Element type is invalid".
// This no-op component satisfies Plasmo without rendering anything visible.
export default function ContentScript() { return null }

// possible moment — before the DOM is even built.
// This is critical so the tracker gets in before any page scripts run.
export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_start"
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. Inject Listener Tracker into MAIN world
//
// Loads tracker.js via chrome.runtime.getURL() — a chrome-extension:// URL
// which is NOT subject to the page's Content Security Policy.
// This works on strict CSP pages (YouTube, Google, etc.) where blob: and
// inline scripts are blocked.
// tracker.js is declared in web_accessible_resources in package.json so
// Chrome allows it to be loaded by pages.
// ─────────────────────────────────────────────────────────────────────────────
const injectTracker = () => {
  const s = document.createElement("script")
  s.src = chrome.runtime.getURL("assets/tracker.js")
  ;(document.head || document.documentElement).appendChild(s)
  s.onload = () => s.remove()
}
injectTracker()

// ─────────────────────────────────────────────────────────────────────────────
// Relay MAIN world stats → Extension
//
// tracker.ts broadcasts via window.postMessage every 3 seconds.
// Content scripts can't directly access MAIN world variables, so this
// message listener is the bridge: MAIN world → content script → extension.
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener("message", (e) => {
  if (e.data?.type === "SENTINEL_LISTENER_STATS") {
    const total = e.data.total
    chrome.runtime
      .sendMessage({ type: "LISTENER_UPDATE", total })
      .catch(() => {})
    // Persist listener total so sidepanel can read it on tab switch
    chrome.storage.session.get("sentinelTabData").then((store) => {
      const tabData = store.sentinelTabData || {}
      const key = location.href
      tabData[key] = { ...(tabData[key] || {}), listenerTotal: total }
      chrome.storage.session.set({ sentinelTabData: tabData })
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Culprit store — URLs of heavy images flagged during long tasks.
// Stored on window so the SCAN_FUNC injected by sidepanel.tsx can also read it.
// ─────────────────────────────────────────────────────────────────────────────
;(window as any).__sentinelCulprits = (window as any).__sentinelCulprits || new Set<string>()

// ─────────────────────────────────────────────────────────────────────────────
// Inject the sentinel pulse keyframe CSS once.
// The id check prevents duplicates if the script somehow runs twice on the same page.
// ─────────────────────────────────────────────────────────────────────────────
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
  ;(document.head || document.documentElement).appendChild(s)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DOM Stats helper — iterative traversal (safe for deeply nested pages)
//
// Uses an iterative stack instead of recursion — recursion would crash on
// deeply nested pages (stack overflow).
// Starts at documentElement with depth 1, pushes all children with depth + 1,
// tracks the maximum depth seen.
// ─────────────────────────────────────────────────────────────────────────────
const getDOMStats = () => {
  const allNodes = document.querySelectorAll("*")
  let maxDepth = 0
  const stack: [Element, number][] = [[document.documentElement, 1]]
  while (stack.length) {
    const [node, depth] = stack.pop()!
    maxDepth = Math.max(maxDepth, depth)
    for (const child of node.children) stack.push([child, depth + 1])
  }
  return { nodeCount: allNodes.length, depth: maxDepth }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Resource / Image / Font Observer
//
// PerformanceObserver fires whenever the browser records a performance entry.
// buffered: true means it also delivers entries recorded before this observer
// was created — important since document_start runs very early.
//
// Image tracking: if an image took > 800ms to load, add it to the culprits Set
//                 and log a console warning.
// Font tracking:  track the responseEnd of the slowest font file as FLT
//                 (Font Load Time) and send it to the sidepanel.
// ─────────────────────────────────────────────────────────────────────────────
let maxFontLoadTime = 0

const imageObserver = new PerformanceObserver((list) => {
  list.getEntries().forEach((entry) => {
    const re = entry as PerformanceResourceTiming

    // ── Image tracking ────────────────────────────────────────────────────────
    if (
      re.initiatorType === "img" ||
      re.name.match(/\.(jpg|jpeg|png|gif|webp|avif)/i)
    ) {
      if (re.duration > 800) {
        // Flag this image URL as a culprit
        ;(window as any).__sentinelCulprits.add(re.name)
        console.warn(
          `%c[Sentinel] Heavy image detected: ${re.name} (${Math.round(re.duration)}ms)`,
          "color: #ffaa00;"
        )
      }
    }

    // ── Font tracking ─────────────────────────────────────────────────────────
    if (
      re.initiatorType === "css" ||
      re.initiatorType === "font" ||
      re.name.match(/\.(woff2|woff|ttf|otf)/i)
    ) {
      const loadTime = re.responseEnd   // responseEnd = time the last byte arrived
      if (loadTime > maxFontLoadTime) {
        maxFontLoadTime = loadTime
        chrome.runtime
          .sendMessage({ type: "VITALS_UPDATE", metric: "FLT", value: `${Math.round(maxFontLoadTime)}ms` })
          .catch(() => {})
      }
    }
  })
})
imageObserver.observe({ type: "resource", buffered: true })

// ─────────────────────────────────────────────────────────────────────────────
// Core Web Vitals state — accumulated across the page lifetime
// ─────────────────────────────────────────────────────────────────────────────
let clsScore = 0
let tbtAccumulator = 0

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLS — Cumulative Layout Shift ("The Jumpy Page")
//
// Every time an element moves unexpectedly, the browser records a layout-shift
// entry with a value (0–1 scale). We accumulate all of them.
// hadRecentInput: true means the user just clicked/typed — those shifts are
// intentional and excluded per the CLS spec.
// ─────────────────────────────────────────────────────────────────────────────
const clsObserver = new PerformanceObserver((entryList) => {
  for (const entry of entryList.getEntries()) {
    const ls = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }
    if (!ls.hadRecentInput) {
      clsScore += ls.value
      chrome.runtime
        .sendMessage({ type: "VITALS_UPDATE", metric: "CLS", value: clsScore.toFixed(4) })
        .catch(() => {})
    }
  }
})
clsObserver.observe({ type: "layout-shift", buffered: true })

// ─────────────────────────────────────────────────────────────────────────────
// 4. FCP — First Contentful Paint
//
// The browser fires a 'paint' entry named 'first-contentful-paint' when it
// first renders any text or image. startTime = ms since navigation started.
// We also trigger Speed Index calculation here since FCP is one of its inputs.
// ─────────────────────────────────────────────────────────────────────────────
const fcpObserver = new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries()
  const fcp = entries.find((e) => e.name === "first-contentful-paint")
  if (fcp) {
    chrome.runtime
      .sendMessage({ type: "VITALS_UPDATE", metric: "FCP", value: `${Math.round(fcp.startTime)}ms` })
      .catch(() => {})
    calculateSpeedIndex(fcp.startTime)
  }
})
fcpObserver.observe({ type: "paint", buffered: true })

// ─────────────────────────────────────────────────────────────────────────────
// 5. LCP — Largest Contentful Paint ("The Waiting Game")
//
// The browser keeps updating LCP as larger elements appear on screen.
// We always take the LAST entry because LCP is defined as the final candidate
// before the user first interacts with the page.
// ─────────────────────────────────────────────────────────────────────────────
let lastLcpValue = 0

const lcpObserver = new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries()
  const lastEntry = entries[entries.length - 1]
  lastLcpValue = lastEntry.startTime
  chrome.runtime
    .sendMessage({ type: "VITALS_UPDATE", metric: "LCP", value: `${Math.round(lastEntry.startTime)}ms` })
    .catch(() => {})
  calculateSpeedIndex()
})
lcpObserver.observe({ type: "largest-contentful-paint", buffered: true })

// ─────────────────────────────────────────────────────────────────────────────
// Speed Index (Approx) — Heuristic: FCP + 0.8 * (LCP - FCP)
//
// The real Speed Index requires video analysis of the page loading.
// This heuristic estimates it: most visual progress happens between FCP and LCP,
// and we weight it at 80% of that gap.
// Called from both FCP and LCP observers since we need both values.
// ─────────────────────────────────────────────────────────────────────────────
const calculateSpeedIndex = (fcpVal?: number) => {
  // Use the passed value or look it up from the performance timeline
  const fcp = fcpVal ?? performance.getEntriesByName("first-contentful-paint")[0]?.startTime
  if (fcp && lastLcpValue) {
    const si = fcp + (lastLcpValue - fcp) * 0.8
    chrome.runtime
      .sendMessage({ type: "VITALS_UPDATE", metric: "SI", value: `${Math.round(si)}ms` })
      .catch(() => {})
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. FID — First Input Delay ("The Sticky Button")
//
// startTime = when the user clicked/tapped.
// processingStart = when the browser actually started handling it.
// The gap between them is the delay caused by the main thread being busy.
// ─────────────────────────────────────────────────────────────────────────────
const fidObserver = new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries()
  entries.forEach((entry) => {
    const fi = entry as PerformanceEventTiming
    const delay = fi.processingStart - fi.startTime
    chrome.runtime
      .sendMessage({ type: "VITALS_UPDATE", metric: "FID", value: `${Math.round(delay)}ms` })
      .catch(() => {})
  })
})
fidObserver.observe({ type: "first-input", buffered: true })

// ─────────────────────────────────────────────────────────────────────────────
// 7. INP — Interaction to Next Paint
//
// Unlike FID which only measures the FIRST interaction, INP tracks ALL
// interactions throughout the session and reports the worst case.
// interactionId is only set on user-initiated events (not programmatic ones).
// durationThreshold: 16 is required — without it Chrome defaults to 104ms
// and silently drops most interactions, making INP appear broken.
// ─────────────────────────────────────────────────────────────────────────────
let maxInteractionLatency = 0

const inpObserver = new PerformanceObserver((entryList) => {
  for (const entry of entryList.getEntries()) {
    const ev = entry as PerformanceEventTiming & { interactionId?: number }
    if (ev.interactionId && ev.interactionId > 0) {
      maxInteractionLatency = Math.max(maxInteractionLatency, ev.duration)
      const value = `${Math.round(maxInteractionLatency)}ms`
      chrome.runtime
        .sendMessage({ type: "VITALS_UPDATE", metric: "INP", value })
        .catch(() => {})
      // Persist so sidepanel can read it on tab switch
      chrome.storage.session.get("sentinelTabData").then((store) => {
        const tabData = store.sentinelTabData || {}
        const key = location.href
        tabData[key] = { ...(tabData[key] || {}), INP: value }
        chrome.storage.session.set({ sentinelTabData: tabData })
      })
    }
  }
})
// durationThreshold: 16 = one frame — catches all meaningful interactions
// buffered: false because "event" type doesn't support buffering
inpObserver.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit)

// ─────────────────────────────────────────────────────────────────────────────
// 8. Network Hints Scanner
//
// After the page fully loads, scan the <head> for preconnect and dns-prefetch
// link tags. These are performance hints that tell the browser to warm up
// connections early. Sends the full list to the sidepanel for display.
// ─────────────────────────────────────────────────────────────────────────────
const scanNetworkHints = () => {
  const hints = Array.from(
    document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]')
  ).map((link) => ({
    rel: (link as HTMLLinkElement).rel,
    href: (link as HTMLLinkElement).href
  }))
  chrome.runtime.sendMessage({ type: "HINTS_UPDATE", hints }).catch(() => {})
}
window.addEventListener("load", scanNetworkHints)

// ─────────────────────────────────────────────────────────────────────────────
// 9. Long Task Observer — TBT accumulation + LCP "Blame" + Image-to-Freeze
//
// A Long Task is any task that blocks the main thread for more than 50ms.
// Users feel these as dropped frames or unresponsive buttons.
//
// TBT (Total Blocking Time) = sum of (duration - 50) for every long task.
// The "excess" blocking time beyond the 50ms threshold is what we accumulate.
//
// Blame logic: when a long task fires, we check what the current LCP element
// is and add the pulsing red outline to it. If the browser froze while that
// element was being rendered, it's likely the cause.
//
// Image-to-Freeze: also flags any images that haven't finished loading yet
// at the time of the freeze — they are likely contributing to the block.
// ─────────────────────────────────────────────────────────────────────────────
const longTaskObserver = new PerformanceObserver((list) => {
  list.getEntries().forEach((task) => {
    // longtask entries are always > 50ms by spec — no need to check
    // TBT = sum of (duration - 50ms) for each long task
    tbtAccumulator += task.duration - 50
    chrome.runtime
      .sendMessage({ type: "VITALS_UPDATE", metric: "TBT", value: `${Math.round(tbtAccumulator)}ms` })
      .catch(() => {})

    // Notify sidepanel to increment the Long Tasks counter
    chrome.runtime
      .sendMessage({ type: "LONG_TASK", duration: task.duration })
      .catch(() => {})

    // Persist long task count for tab-switch restore
    chrome.storage.session.get("sentinelTabData").then((store) => {
      const tabData = store.sentinelTabData || {}
      const key = location.href
      const prev = tabData[key]?.longTaskCount || 0
      tabData[key] = { ...(tabData[key] || {}), longTaskCount: prev + 1 }
      chrome.storage.session.set({ sentinelTabData: tabData })
    })

    console.error(`🚨 UI FREEZE DETECTED: ${task.duration.toFixed(2)}ms long task on main thread`)

    // ── Blame Logic: correlate the freeze with the current LCP element ──────
    performance.getEntriesByType("largest-contentful-paint").forEach((lcp) => {
      const lcpEntry = lcp as LargestContentfulPaintEntry
      if (lcpEntry.element) {
        console.error(
          `%cCULPRIT FOUND: The UI froze for ${task.duration.toFixed(2)}ms while rendering this ${lcpEntry.element.tagName}:`,
          "color: #ff4455; font-weight: bold;",
          lcpEntry.element
        )
        lcpEntry.element.classList.add("__sentinel-culprit")
        ;(lcpEntry.element as HTMLElement).title =
          `[Sentinel] Blamed for ${task.duration.toFixed(0)}ms UI freeze`
      }
    })

    // ── Image-to-Freeze Correlation ──────────────────────────────────────────
    const imageList = Array.from(document.querySelectorAll("img")).filter(
      (img) => !img.complete || img.naturalWidth === 0
    )
    imageList.forEach((img) => {
      if (img.src) (window as any).__sentinelCulprits.add(img.src)
      img.classList.add("__sentinel-culprit")
    })
  })
})
// buffered: true is NOT supported for longtask — Chrome silently ignores it
longTaskObserver.observe({ type: "longtask" })

// ─────────────────────────────────────────────────────────────────────────────
// 10. Periodic memory + DOM logging
//
// Every 5 seconds, logs JS heap size + DOM node count + DOM depth to the
// console in green. Uses getDOMStats() for the iterative depth traversal.
//
// Pauses when the tab is hidden (Page Visibility API) to avoid wasting
// resources on background tabs, and resumes when the tab becomes visible again.
// ─────────────────────────────────────────────────────────────────────────────
let intervalId: ReturnType<typeof setInterval> | null = null

const startLogging = () => {
  // performance.memory is a Chrome-only non-standard API — guard before using it
  if (!(performance as any).memory) return
  intervalId = setInterval(() => {
    const memMB = ((performance as any).memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)
    const stats = getDOMStats()
    console.log(
      `%c Sentinel | RAM: ${memMB}MB | Nodes: ${stats.nodeCount} | Depth: ${stats.depth}`,
      "color: #00ff88; font-weight: bold;"
    )
  }, 5000)
}

const stopLogging = () => {
  if (intervalId) clearInterval(intervalId)
}

// Page Visibility API — fires when the user switches tabs or minimises the window
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    // Notify the sidepanel that this tab is now active — replaces chrome.tabs.onActivated
    chrome.runtime.sendMessage({ type: "TAB_ACTIVATED" }).catch(() => {})
  }
  document.hidden ? stopLogging() : startLogging()
})

startLogging()

// ─────────────────────────────────────────────────────────────────────────────
// 11. SEO Diagnostics Scanner
//
// Extracts key SEO metadata from the active webpage and relays it to the side panel.
// Runs once after the page is fully loaded or when requested.
// ─────────────────────────────────────────────────────────────────────────────
const scanSEO = () => {
  const seoStats = {
    title: document.title || "",
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    h1Count: document.querySelectorAll("h1").length,
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
    robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
    imagesTotal: 0,
    imagesMissingAlt: 0,
  }

  const images = Array.from(document.querySelectorAll("img"))
  seoStats.imagesTotal = images.length
  seoStats.imagesMissingAlt = images.filter((img) => !img.hasAttribute("alt") || img.getAttribute("alt")?.trim() === "").length

  chrome.runtime.sendMessage({ type: "SEO_UPDATE", seoStats, location: location.href }).catch(() => {})
}

window.addEventListener("load", scanSEO)
