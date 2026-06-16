const MAX_CONCURRENT_FULL_PARSES = 1
let fullParseActiveCount = 0
/** @type {Array<{ resolve: () => void, priority: number }>} */
const fullParseWaitQueue = []
const PARSE_GATE_UPLOAD_PRIORITY = 10
const PARSE_GATE_REPARSE_PRIORITY = 0

function isFullParseGateFree() {
  return fullParseActiveCount < MAX_CONCURRENT_FULL_PARSES
}

function releaseFullParseSlot() {
  fullParseActiveCount = Math.max(0, fullParseActiveCount - 1)
  const next = fullParseWaitQueue.shift()
  if (next) {
    next.resolve()
  }
}

function tryAcquireFullParseSlot() {
  if (fullParseActiveCount >= MAX_CONCURRENT_FULL_PARSES) {
    return null
  }
  fullParseActiveCount += 1
  return releaseFullParseSlot
}

function enqueueFullParseWaiter(resolve, priority = 0) {
  const entry = { resolve, priority }
  const insertBefore = fullParseWaitQueue.findIndex((item) => item.priority < priority)
  if (insertBefore === -1) {
    fullParseWaitQueue.push(entry)
  } else {
    fullParseWaitQueue.splice(insertBefore, 0, entry)
  }
}

async function acquireFullParseSlot(priority = 0) {
  while (fullParseActiveCount >= MAX_CONCURRENT_FULL_PARSES) {
    await new Promise((resolve) => {
      enqueueFullParseWaiter(resolve, priority)
    })
  }
  fullParseActiveCount += 1
  return releaseFullParseSlot
}

async function runWithFullParseGate(task, { wait = true, priority = 0, onWaiting } = {}) {
  let release = wait ? null : tryAcquireFullParseSlot()
  if (!release && wait) {
    onWaiting?.()
    release = await acquireFullParseSlot(priority)
  }
  if (!release) {
    return { skipped: true }
  }

  try {
    return await task()
  } finally {
    release()
  }
}

export {
  runWithFullParseGate,
  PARSE_GATE_UPLOAD_PRIORITY,
  PARSE_GATE_REPARSE_PRIORITY,
}
