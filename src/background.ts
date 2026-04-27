// Plasmo auto-registers this file as the Chrome service worker.

// Remove the default_popup so the toolbar icon click fires onClicked instead of opening a popup.
// With a default_popup set, Chrome intercepts the click and onClicked never fires.
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setPopup({ popup: "" })
})

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return
  chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true })
  chrome.sidePanel.open({ tabId: tab.id })
})

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "CHECK_INDEXABILITY") {
    handleIndexabilityCheck(request.url).then(sendResponse)
    return true // indicates async response
  } else if (request.type === "GET_REDIRECT_TRACE") {
    sendResponse({ success: true, trace: tabRedirects.get(request.tabId) || [] })
    return false // indicates sync response
  }
})

// ── Link Redirect Trace Memory ────────────────────────────────────────────────
interface Hop {
  url: string
  statusCode: number
}

// Map of tabId -> Array of redirect hops
const tabRedirects = new Map<number, Hop[]>()

// 1. Reset trace when a new main_frame request starts
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) {
      tabRedirects.set(details.tabId, [])
    }
  },
  { urls: ["<all_urls>"] }
)

// 2. Capture 3XX redirects
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) {
      const trace = tabRedirects.get(details.tabId) || []
      trace.push({ url: details.url, statusCode: details.statusCode })
      tabRedirects.set(details.tabId, trace)
    }
  },
  { urls: ["<all_urls>"] }
)

// 3. Capture the final destination to complete the trace
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) {
      const trace = tabRedirects.get(details.tabId) || []
      // If we have redirects, cap off the sequence with the final 200 OK
      if (trace.length > 0) {
        trace.push({ url: details.url, statusCode: details.statusCode })
        tabRedirects.set(details.tabId, trace)
      }
    }
  },
  { urls: ["<all_urls>"] }
)

async function handleIndexabilityCheck(urlStr: string) {
  try {
    const targetUrl = new URL(urlStr)
    
    // 1. Fetch HEAD to get X-Robots-Tag
    let xRobotsTag = ""
    try {
      const headRes = await fetch(targetUrl.href, { method: "HEAD" })
      xRobotsTag = headRes.headers.get("x-robots-tag") || ""
    } catch (e) {
      console.warn("Failed to fetch HEAD for X-Robots-Tag:", e)
    }

    // 2. Fetch robots.txt
    let isBlockedByRobotsTxt = false
    try {
      const robotsUrl = new URL("/robots.txt", targetUrl.origin).href
      const robotsRes = await fetch(robotsUrl)
      if (robotsRes.ok) {
        const robotsText = await robotsRes.text()
        const fullPath = targetUrl.pathname + targetUrl.search
        isBlockedByRobotsTxt = checkRobotsTxt(robotsText, fullPath)
      }
    } catch (e) {
      console.warn("Failed to fetch or parse robots.txt:", e)
    }

    return { success: true, xRobotsTag, isBlockedByRobotsTxt }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

// Basic robots.txt parser
function checkRobotsTxt(robotsText: string, path: string): boolean {
  const lines = robotsText.split("\n")
  let relevantAgent = false
  let isBlocked = false

  for (let line of lines) {
    line = line.split("#")[0].trim()
    if (!line) continue

    const lowerLine = line.toLowerCase()
    if (lowerLine.startsWith("user-agent:")) {
      const agent = lowerLine.substring(11).trim()
      if (agent === "*" || agent === "googlebot") {
        relevantAgent = true
      } else {
        relevantAgent = false
      }
    } else if (relevantAgent && lowerLine.startsWith("disallow:")) {
      let rule = line.substring(9).trim()
      if (rule === "") continue
      if (rule.endsWith("*")) rule = rule.slice(0, -1)
      if (path.startsWith(rule)) isBlocked = true
    } else if (relevantAgent && lowerLine.startsWith("allow:")) {
      let rule = line.substring(6).trim()
      if (rule === "") continue
      if (rule.endsWith("*")) rule = rule.slice(0, -1)
      if (path.startsWith(rule)) isBlocked = false
    }
  }
  return isBlocked
}
