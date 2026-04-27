(function() {
  if (window.__sentinelTrackerInstalled) return;
  window.__sentinelTrackerInstalled = true;

  const expensiveTypes = ['scroll', 'mousemove', 'resize', 'wheel', 'touchmove'];
  const listenerCounts = new Map();
  let totalExpensive = 0;

  const originalAdd    = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (expensiveTypes.includes(type)) {
      if (!listenerCounts.has(this)) listenerCounts.set(this, new Map());
      const elMap = listenerCounts.get(this);
      elMap.set(type, (elMap.get(type) || 0) + 1);
      totalExpensive++;
      if (elMap.get(type) > 15) {
        this.dataset = this.dataset || {};
        this.dataset.sentinelBloat = 'true';
      }
    }
    return originalAdd.apply(this, arguments);
  };

  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (expensiveTypes.includes(type)) {
      if (listenerCounts.has(this)) {
        const elMap = listenerCounts.get(this);
        if (elMap.has(type) && elMap.get(type) > 0) {
          elMap.set(type, elMap.get(type) - 1);
          totalExpensive = Math.max(0, totalExpensive - 1);
        }
      }
    }
    return originalRemove.apply(this, arguments);
  };

  setInterval(() => {
    window.postMessage({ type: 'SENTINEL_LISTENER_STATS', total: totalExpensive }, '*');
  }, 3000);
})();
