// ==UserScript==
// @name         Swagger 接口 URL 搜索
// @namespace    https://xt.ty.chaomeifan.com/
// @version      1.1.5
// @description  按 URL 跨 Select a spec 分组搜索 Swagger 接口，并跳转到对应分组
// @match        *://*.chaomeifan.com/api/*/swagger-ui.html*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

;(function () {
  'use strict'

  const ROOT_CLASS = 'swagger-url-search'
  const MAX_RESULTS = 30
  const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
  const PENDING_JUMP_KEY = 'swagger-url-search-jump'
  const specCache = new Map()
  let operations = []
  let activeIndex = -1
  let loadPromise = null
  let loadProgress = { loaded: 0, total: 0 }
  let rerenderSearch = () => {}

  GM_addStyle(`
    .${ROOT_CLASS} {
      position: relative;
      z-index: 20;
      width: 100%;
      margin: 16px 0 4px;
      font-family: sans-serif;
    }

    .${ROOT_CLASS}-box {
      position: relative;
      display: flex;
      align-items: center;
    }

    .${ROOT_CLASS} svg {
      position: absolute;
      left: 10px;
      z-index: 1;
      width: 16px;
      height: 16px;
      fill: none;
      stroke: #8b93a7;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }

    .${ROOT_CLASS}-box:focus-within svg {
      stroke: #61affe;
    }

    .${ROOT_CLASS}-input {
      box-sizing: border-box;
      flex: 1 1 auto;
      width: 100%;
      height: 36px;
      padding: 0 72px 0 36px !important;
      border: 1px solid #d8dde7;
      border-radius: 4px;
      outline: none;
      background: #fff;
      color: #3b4151;
      font-size: 14px;
      appearance: none;
    }

    .${ROOT_CLASS}-input:focus {
      border-color: #61affe;
    }

    .${ROOT_CLASS}-input::-webkit-search-decoration,
    .${ROOT_CLASS}-input::-webkit-search-cancel-button {
      appearance: none;
    }

    .${ROOT_CLASS}-input::placeholder {
      color: #9aa3b5;
    }

    .${ROOT_CLASS}-meta {
      position: absolute;
      right: 10px;
      color: #8b93a7;
      font-size: 12px;
      pointer-events: none;
      white-space: nowrap;
    }

    .${ROOT_CLASS}-list {
      position: absolute;
      left: 0;
      right: 0;
      z-index: 30;
      display: none;
      overflow: auto;
      max-height: min(70vh, 520px);
      margin-top: 8px;
      padding: 6px;
      border: 1px solid #d8dde7;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 12px 32px rgba(59, 65, 81, 0.16);
    }

    .${ROOT_CLASS}-list.is-open {
      display: block;
    }

    .${ROOT_CLASS}-empty,
    .${ROOT_CLASS}-item {
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 13px;
    }

    .${ROOT_CLASS}-empty {
      color: #8b93a7;
    }

    .${ROOT_CLASS}-item {
      display: grid;
      gap: 4px;
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    .${ROOT_CLASS}-item.is-active,
    .${ROOT_CLASS}-item:hover {
      background: rgba(97, 175, 254, 0.1);
    }

    .${ROOT_CLASS}-item-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .${ROOT_CLASS}-method {
      flex: 0 0 auto;
      min-width: 52px;
      padding: 1px 6px;
      border-radius: 4px;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      line-height: 18px;
      text-align: center;
    }

    .${ROOT_CLASS}-method.is-get { background: #61affe; }
    .${ROOT_CLASS}-method.is-post { background: #49cc90; }
    .${ROOT_CLASS}-method.is-put { background: #fca130; }
    .${ROOT_CLASS}-method.is-delete { background: #f93e3e; }
    .${ROOT_CLASS}-method.is-patch { background: #50e3c2; color: #1b1b1b; }
    .${ROOT_CLASS}-method.is-head,
    .${ROOT_CLASS}-method.is-options { background: #9012fe; }

    .${ROOT_CLASS}-path {
      overflow: hidden;
      color: #3b4151;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .${ROOT_CLASS}-path mark {
      padding: 0;
      background: #ffe58f;
      color: inherit;
    }

    .${ROOT_CLASS}-item-sub {
      display: flex;
      gap: 8px;
      min-width: 0;
      padding-left: 60px;
      color: #6b7280;
      font-size: 12px;
    }

    .${ROOT_CLASS}-tag,
    .${ROOT_CLASS}-summary {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .${ROOT_CLASS}-tag {
      flex: 0 1 auto;
      max-width: 48%;
      color: #3b4151;
      font-weight: 600;
    }

    .opblock.swagger-url-search-highlight {
      outline: 2px solid #61affe;
      outline-offset: 2px;
    }
  `)

  function cleanText(value) {
    return String(value || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function resolveUrl(url) {
    return new URL(url, location.href).href
  }

  function urlsMatch(left, right) {
    if (!left || !right) return false
    try {
      return resolveUrl(left) === resolveUrl(right)
    } catch (error) {
      return left === right
    }
  }

  function getSpecSelect() {
    return document.querySelector('#select') || document.querySelector('.topbar select')
  }

  function getCurrentSpecUrl() {
    return getSpecSelect()?.value || document.querySelector('.info .url')?.textContent?.trim()
  }

  function listSpecsFromSelect() {
    return Array.from(getSpecSelect()?.options || [])
      .map((option) => {
        const url = option.value?.trim()
        if (!url) return null
        return { name: cleanText(option.textContent) || url, url }
      })
      .filter(Boolean)
  }

  function listSpecsFromUi() {
    try {
      const urls = window.ui?.getConfigs?.()?.urls
      if (!Array.isArray(urls) || !urls.length) return []
      return urls
        .map((item) => {
          const url = (item.url || item).trim?.() || item.url
          if (!url) return null
          return { name: cleanText(item.name) || url, url }
        })
        .filter(Boolean)
    } catch (error) {
      return []
    }
  }

  async function listSpecsFromResources() {
    const currentUrl = getCurrentSpecUrl()
    const candidates = []
    if (currentUrl) {
      candidates.push(currentUrl.replace(/\/v[23]\/api-docs.*$/i, '/swagger-resources'))
    }
    candidates.push(new URL('swagger-resources', location.href.replace(/swagger-ui\.html.*$/i, '')).href)

    for (const resourceUrl of [...new Set(candidates)]) {
      try {
        const response = await fetch(resourceUrl, { credentials: 'include' })
        if (!response.ok) continue
        const resources = await response.json()
        if (!Array.isArray(resources) || !resources.length) continue
        return resources
          .map((item) => {
            const url = item.url || item.location
            if (!url) return null
            return { name: cleanText(item.name) || url, url: new URL(url, resourceUrl).href }
          })
          .filter(Boolean)
      } catch (error) {
        // try next candidate
      }
    }

    return []
  }

  async function listSpecs() {
    const pick = () => {
      const fromUi = listSpecsFromUi()
      if (fromUi.length > 1) return fromUi
      const fromSelect = listSpecsFromSelect()
      if (fromSelect.length > 1) return fromSelect
      return []
    }

    const immediate = pick()
    if (immediate.length) return immediate

    const fromResources = await listSpecsFromResources()
    if (fromResources.length > 1) return fromResources

    const startedAt = Date.now()
    while (Date.now() - startedAt < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const later = pick()
      if (later.length) return later
    }

    if (fromResources.length) return fromResources

    const fromSelect = listSpecsFromSelect()
    const fromUi = listSpecsFromUi()
    const currentUrl = getCurrentSpecUrl()
    if (fromSelect.length) return fromSelect
    if (fromUi.length) return fromUi
    if (currentUrl) return [{ name: '当前分组', url: currentUrl }]
    throw new Error('没有找到 Swagger 分组列表')
  }

  function buildFullUrl(spec, path) {
    const scheme = (spec.schemes && spec.schemes[0]) || location.protocol.replace(':', '')
    const host = spec.host || location.host
    const basePath = String(spec.basePath || '').replace(/\/$/, '')
    return `${scheme}://${host}${basePath}${path}`
  }

  function collectOperations(spec, specInfo) {
    const items = []

    Object.entries(spec.paths || {}).forEach(([path, pathItem]) => {
      METHODS.forEach((method) => {
        const operation = pathItem?.[method]
        if (!operation) return

        const tags = operation.tags?.length ? operation.tags : ['default']
        items.push({
          path,
          fullUrl: buildFullUrl(spec, path),
          method,
          summary: cleanText(operation.summary || operation.description),
          tags,
          operationId: operation.operationId || '',
          specName: specInfo.name,
          specUrl: specInfo.url,
        })
      })
    })

    return items
  }

  function fetchSpec(url) {
    const resolved = resolveUrl(url)
    if (specCache.has(resolved)) return specCache.get(resolved)

    const request = fetch(resolved, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error(`Swagger JSON 加载失败：HTTP ${response.status}`)
        return response.json()
      })
      .catch((error) => {
        specCache.delete(resolved)
        throw error
      })

    specCache.set(resolved, request)
    return request
  }

  function ensureOperations() {
    if (loadPromise) return loadPromise

    loadPromise = listSpecs()
      .then(async (specs) => {
        operations = []
        loadProgress = { loaded: 0, total: specs.length }
        rerenderSearch()

        await Promise.all(
          specs.map(async (specInfo) => {
            try {
              const spec = await fetchSpec(specInfo.url)
              operations = operations.concat(collectOperations(spec, specInfo))
            } catch (error) {
              console.error('[Swagger 搜索]', specInfo.name, error)
            } finally {
              loadProgress.loaded += 1
              rerenderSearch()
            }
          })
        )
        return operations
      })
      .catch((error) => {
        loadPromise = null
        throw error
      })

    return loadPromise
  }

  function parseQuery(raw) {
    const value = cleanText(raw).toLowerCase()
    const matched = value.match(/^(get|post|put|delete|patch|head|options)\s+(.+)$/)
    if (!matched) return { method: '', text: value }
    return { method: matched[1], text: cleanText(matched[2]) }
  }

  function matches(item, query) {
    if (query.method && item.method !== query.method) return false
    if (!query.text) return !query.method

    const haystack = `${item.path}\n${item.fullUrl}`.toLowerCase()
    return haystack.includes(query.text)
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function highlight(text, query) {
    const value = escapeHtml(text)
    if (!query.text) return value

    const index = text.toLowerCase().indexOf(query.text)
    if (index < 0) return value

    const start = escapeHtml(text.slice(0, index))
    const match = escapeHtml(text.slice(index, index + query.text.length))
    const end = escapeHtml(text.slice(index + query.text.length))
    return `${start}<mark>${match}</mark>${end}`
  }

  function search(raw) {
    const query = parseQuery(raw)
    if (!query.method && !query.text) return []
    return operations.filter((item) => matches(item, query)).slice(0, MAX_RESULTS)
  }

  function tagLabel(item) {
    const tags = item.tags.filter((tag) => tag && tag !== item.specName).join(' / ')
    if (item.specName && tags) return `${item.specName} · ${tags}`
    return item.specName || tags
  }

  function waitUntil(predicate, timeout) {
    if (predicate()) return Promise.resolve(true)

    return new Promise((resolve) => {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer)
          resolve(true)
          return
        }
        if (Date.now() - startedAt > timeout) {
          clearInterval(timer)
          resolve(false)
        }
      }, 50)
    })
  }

  function getUi() {
    return window.ui || window.swaggerUi || null
  }

  function currentPrimaryName() {
    return new URLSearchParams(location.search).get('urls.primaryName') || ''
  }

  function isCurrentSpec(item) {
    if (!item?.specUrl && !item?.specName) return true
    if (item.specName && currentPrimaryName() === item.specName) return true
    return urlsMatch(getCurrentSpecUrl(), item.specUrl)
  }

  function triggerSelectChange(select, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    descriptor?.set?.call(select, value)
    select.value = value
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function buildDeepLink(item) {
    const tag = item.tags?.[0] || 'default'
    if (item.operationId) return `/${encodeURIComponent(tag)}/${encodeURIComponent(item.operationId)}`
    return `/${encodeURIComponent(tag)}`
  }

  function pathMatches(shown, expected) {
    if (!shown || !expected) return false
    try {
      shown = decodeURIComponent(shown)
    } catch (error) {
      // keep original
    }
    return shown === expected || shown.endsWith(expected) || expected.endsWith(shown)
  }

  function findTagButton(tagName) {
    return Array.from(document.querySelectorAll('.opblock-tag')).find((tag) => {
      const label = cleanText(tag.querySelector('a span, span, a')?.textContent || tag.textContent)
      return label === tagName || label.startsWith(`${tagName} `) || label.includes(tagName)
    })
  }

  function expandTag(tagName) {
    const tag = findTagButton(tagName)
    if (!tag) return false

    const section = tag.closest('.opblock-tag-section')
    if (section?.classList.contains('is-open')) return true

    const expander = tag.querySelector('button.expand-operation') || tag.querySelector('a.nostyle') || tag
    expander.click()
    return true
  }

  function findOpblock(item) {
    return Array.from(document.querySelectorAll('.opblock-summary')).find((summary) => {
      const method = cleanText(summary.querySelector('.opblock-summary-method')?.textContent).toLowerCase()
      const pathNode = summary.querySelector('.opblock-summary-path')
      const path = cleanText(pathNode?.dataset.path || pathNode?.querySelector('span')?.textContent)
      return method === item.method && pathMatches(path, item.path)
    })?.closest('.opblock')
  }

  async function waitForOpblock(item, timeout = 8000) {
    await waitUntil(() => findOpblock(item), timeout)
    return findOpblock(item)
  }

  async function switchSpec(item) {
    if (isCurrentSpec(item)) return true

    const ui = getUi()
    if (ui?.specActions?.updateUrl && ui?.specActions?.download) {
      ui.specActions.updateUrl(item.specUrl)
      ui.specActions.download(item.specUrl)
    }

    const select = getSpecSelect()
    if (select) {
      const option = Array.from(select.options).find((optionItem) => urlsMatch(optionItem.value, item.specUrl) || optionItem.textContent.trim() === item.specName)
      const nextValue = option?.value || item.specUrl
      if (nextValue) triggerSelectChange(select, nextValue)
    }

    const switched = await waitUntil(() => isCurrentSpec(item) && document.querySelector('.opblock-tag, .opblock-summary'), 2500)
    if (switched) return true

    const nextUrl = new URL(location.href)
    if (item.specName) nextUrl.searchParams.set('urls.primaryName', item.specName)
    nextUrl.hash = buildDeepLink(item)
    sessionStorage.setItem(PENDING_JUMP_KEY, JSON.stringify(item))
    location.assign(nextUrl.toString())
    return false
  }

  async function openOperation(item) {
    const tag = item.tags[0]
    const ui = getUi()
    if (ui?.layoutActions?.show) {
      ui.layoutActions.show(['operations-tag', tag], true)
      if (item.operationId) ui.layoutActions.show(['operations', tag, item.operationId], true)
    }

    location.hash = buildDeepLink(item)
    expandTag(tag)

    const opblock = await waitForOpblock(item, 8000)
    if (!opblock) {
      expandTag(tag)
      await waitForOpblock(item, 2000)
    }

    const target = findOpblock(item)
    if (!target) return

    if (!target.classList.contains('is-open')) {
      const control =
        target.querySelector('.opblock-summary-control') ||
        target.querySelector('.opblock-summary-method') ||
        target.querySelector('.opblock-summary-path')
      control?.click()
    }

    target.classList.add('swagger-url-search-highlight')
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => target.classList.remove('swagger-url-search-highlight'), 1800)
  }

  async function jumpTo(item) {
    const switched = await switchSpec(item)
    if (!switched) return
    await openOperation(item)
  }

  async function resumePendingJump() {
    const raw = sessionStorage.getItem(PENDING_JUMP_KEY)
    if (!raw) return

    sessionStorage.removeItem(PENDING_JUMP_KEY)
    let item
    try {
      item = JSON.parse(raw)
    } catch (error) {
      return
    }

    await waitUntil(() => document.querySelector('.opblock-tag, .opblock-summary'), 8000)
    await openOperation(item)
  }

  function getAnchor() {
    return document.querySelector('.info .description') || document.querySelector('.info')
  }

  function createRoot() {
    const existing = document.querySelector(`.${ROOT_CLASS}`)
    if (existing) return existing

    const root = document.createElement('div')
    root.className = ROOT_CLASS
    root.innerHTML = `
      <div class="${ROOT_CLASS}-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
        <input class="${ROOT_CLASS}-input" type="search" placeholder="按接口 URL 搜索，例如 /user/list 或 GET /order" autocomplete="off" />
        <span class="${ROOT_CLASS}-meta"></span>
      </div>
      <div class="${ROOT_CLASS}-list"></div>
    `

    const input = root.querySelector(`.${ROOT_CLASS}-input`)
    const list = root.querySelector(`.${ROOT_CLASS}-list`)
    const meta = root.querySelector(`.${ROOT_CLASS}-meta`)

    function closeList() {
      list.classList.remove('is-open')
      activeIndex = -1
    }

    function setActive(index) {
      const items = list.querySelectorAll(`.${ROOT_CLASS}-item`)
      if (!items.length) {
        activeIndex = -1
        return
      }

      activeIndex = (index + items.length) % items.length
      items.forEach((item, itemIndex) => item.classList.toggle('is-active', itemIndex === activeIndex))
      items[activeIndex].scrollIntoView({ block: 'nearest' })
    }

    function loadStatus() {
      if (!loadProgress.total || loadProgress.loaded >= loadProgress.total) return ''
      return `加载 ${loadProgress.loaded}/${loadProgress.total}`
    }

    function render(results, raw) {
      const query = parseQuery(raw)
      const loading = loadStatus()
      meta.textContent = raw.trim()
        ? `${results.length}${results.length === MAX_RESULTS ? '+' : ''} 条${loading ? ` · ${loading}` : ''}`
        : loading

      if (!raw.trim()) {
        closeList()
        list.innerHTML = ''
        return
      }

      if (!results.length) {
        const empty = loading ? '正在加载其他分组…' : '全部分组中都没有匹配的接口'
        list.innerHTML = `<div class="${ROOT_CLASS}-empty">${empty}</div>`
        list.classList.add('is-open')
        activeIndex = -1
        return
      }

      list.innerHTML = results
        .map((item, index) => {
          const summary = item.summary ? `<span class="${ROOT_CLASS}-summary">${escapeHtml(item.summary)}</span>` : ''
          return `
            <button type="button" class="${ROOT_CLASS}-item${index === 0 ? ' is-active' : ''}" data-index="${index}">
              <span class="${ROOT_CLASS}-item-main">
                <span class="${ROOT_CLASS}-method is-${item.method}">${item.method.toUpperCase()}</span>
                <span class="${ROOT_CLASS}-path">${highlight(item.path, query)}</span>
              </span>
              <span class="${ROOT_CLASS}-item-sub">
                <span class="${ROOT_CLASS}-tag">${escapeHtml(tagLabel(item))}</span>
                ${summary}
              </span>
            </button>
          `
        })
        .join('')
      list.classList.add('is-open')
      activeIndex = 0
    }

    rerenderSearch = () => {
      if (document.activeElement === input || input.value.trim()) render(search(input.value), input.value)
    }

    async function refresh() {
      const raw = input.value
      try {
        await ensureOperations()
        render(search(raw), raw)
      } catch (error) {
        list.innerHTML = `<div class="${ROOT_CLASS}-empty">${escapeHtml(error.message || '搜索失败')}</div>`
        list.classList.add('is-open')
      }
    }

    input.addEventListener('focus', () => {
      ensureOperations()
      if (input.value.trim()) refresh()
    })
    input.addEventListener('input', refresh)
    input.addEventListener('keydown', (event) => {
      const items = list.querySelectorAll(`.${ROOT_CLASS}-item`)
      if (event.key === 'ArrowDown' && items.length) {
        event.preventDefault()
        setActive(activeIndex + 1)
      } else if (event.key === 'ArrowUp' && items.length) {
        event.preventDefault()
        setActive(activeIndex - 1)
      } else if (event.key === 'Enter' && items.length) {
        event.preventDefault()
        items[Math.max(activeIndex, 0)].click()
      } else if (event.key === 'Escape') {
        closeList()
        input.blur()
      }
    })

    list.addEventListener('mousedown', (event) => event.preventDefault())
    list.addEventListener('click', (event) => {
      const button = event.target.closest(`.${ROOT_CLASS}-item`)
      if (!button) return

      const item = search(input.value)[Number(button.dataset.index)]
      if (!item) return

      closeList()
      jumpTo(item)
    })

    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) closeList()
    })

    return root
  }

  let searchRoot = null
  let scanScheduled = false

  function mountSearch() {
    const anchor = getAnchor()
    if (!anchor) return

    if (!searchRoot) searchRoot = createRoot()
    if (anchor.classList.contains('info')) {
      if (anchor.lastElementChild !== searchRoot) anchor.appendChild(searchRoot)
    } else if (anchor.nextElementSibling !== searchRoot) {
      anchor.insertAdjacentElement('afterend', searchRoot)
    }
  }

  function scheduleMount() {
    if (scanScheduled) return
    scanScheduled = true
    requestAnimationFrame(() => {
      scanScheduled = false
      mountSearch()
    })
  }

  new MutationObserver(scheduleMount).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
  scheduleMount()
  resumePendingJump()
})()
