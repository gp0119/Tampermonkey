// ==UserScript==
// @name         禅道打开需求链接
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  从禅道任务打开需求链接，并在原型目录标记指派给我的未完成任务
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @match        *://zentao.chaomeifan.com/*
// @match        *://redmine.chaomeifan.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

;(function () {
  'use strict'

  const PROTOTYPE_HOST = 'redmine.chaomeifan.com'
  const PROTOTYPE_PAGES_KEY = 'unfinishedPrototypePages'
  const DETAIL_TITLE = '.detail > .detail-title'
  const TASK_LINK = '.c-name a[href*="/task-view-"]'
  const UNFINISHED = ['未开始', '进行中', '已暂停']

  if (location.hostname === PROTOTYPE_HOST) {
    if (window.top === window) highlightPrototypePages()
    return
  }

  const table = document.querySelector('#tasktable')
  if (table && document.querySelector('a.btn-active-text[href$="my-task-assignedTo.html"]')) {
    addTaskListLinks(table).catch((error) => {
      const message = document.createElement('p')
      message.textContent = '需求链接加载失败，请刷新页面重试。'
      message.setAttribute('role', 'status')
      table.before(message)
      console.error('加载禅道需求链接失败', error)
    })
  } else {
    for (const title of document.querySelectorAll(DETAIL_TITLE)) {
      const link = getRequirementLink(title, location.href)
      if (!link) continue

      title.style.display = 'flex'
      title.style.alignItems = 'center'
      title.style.columnGap = '8px'
      title.append(createLinkButton(link))
    }
  }

  function getRequirementLink(title, baseUrl) {
    if (title.textContent.trim() !== '需求描述') return
    const content = title.nextElementSibling
    if (!content?.matches('.detail-content')) return

    const link = content.querySelector('a[href]:not([href=""])')
    if (!link) return
    const url = URL.parse(link.getAttribute('href'), baseUrl)
    if (!url || !['http:', 'https:'].includes(url.protocol)) return

    // 禅道可能把链接的 # 片段留在超链接后的文本里。
    const trailingText = link.nextSibling
    if (!url.hash && trailingText?.nodeType === Node.TEXT_NODE) {
      const fragment = trailingText.textContent.trim().match(/^#\S+/)?.[0]
      if (fragment) url.hash = fragment
    }
    return { url, target: link.target }
  }

  function createLinkButton({ url, target }) {
    const button = document.createElement('a')
    button.href = url.href
    button.target = target
    button.rel = 'noopener'
    button.className = 'btn btn-default btn-sm'
    button.style.marginInlineStart = 'auto'
    button.textContent = '打开需求链接'
    return button
  }

  async function addTaskListLinks(table) {
    const tasks = (await readAssignedTasks(table)).filter((task) => UNFINISHED.includes(task.status))
    const links = new Map()
    for (let index = 0; index < tasks.length; index += 6) {
      await Promise.all(tasks.slice(index, index + 6).map(async ({ href }) => {
        const { doc, url } = await fetchPage(href)
        const title = [...doc.querySelectorAll(DETAIL_TITLE)].find((node) => node.textContent.trim() === '需求描述')
        const link = title && getRequirementLink(title, url)
        if (link) links.set(href, link)
      }))
    }

    // 一次写入全部分页的结果，打开任意原型时都能标记同一文档里的任务。
    const pages = new Set()
    for (const { url } of links.values()) {
      if (url.hostname !== PROTOTYPE_HOST) continue
      const page = new URLSearchParams(url.hash.slice(1)).get('p') ?? url.searchParams.get('p')
      if (page) pages.add(normalizePath(new URL(`${encodeURIComponent(page)}.html`, url).pathname))
    }
    GM_setValue(PROTOTYPE_PAGES_KEY, [...pages])

    for (const taskLink of table.querySelectorAll(TASK_LINK)) {
      const link = links.get(taskLink.href)
      if (!link) continue
      const button = createLinkButton(link)
      button.style.flexShrink = '0'
      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.alignItems = 'center'
      row.style.columnGap = '8px'
      taskLink.style.overflow = 'hidden'
      taskLink.style.textOverflow = 'ellipsis'
      taskLink.before(row)
      row.append(taskLink, button)
    }
  }

  async function readAssignedTasks(table) {
    const pager = table.closest('form').querySelector('ul.pager[data-link-creator]')
    const visibleTasks = readTaskRows(table, location.href)
    const total = Number(pager?.dataset.recTotal ?? visibleTasks.length)
    if (visibleTasks.length === total) return visibleTasks

    const pageSize = Math.max(...Array.from(pager.querySelectorAll('[data-size]'), (item) => Number(item.dataset.size)))
    const tasks = []
    for (let page = 1; page <= Math.ceil(total / pageSize); page++) {
      const href = pager.dataset.linkCreator.replace('{recPerPage}', String(pageSize)).replace('{page}', String(page))
      const { doc, url } = await fetchPage(href)
      const taskTable = doc.querySelector('#tasktable')
      if (!taskTable) throw new Error('禅道响应中没有任务列表')
      tasks.push(...readTaskRows(taskTable, url))
    }
    if (new Set(tasks.map((task) => task.href)).size !== total) throw new Error('分页中的任务数与列表总数不符')
    return tasks
  }

  function readTaskRows(table, url) {
    return Array.from(table.querySelectorAll(`tbody ${TASK_LINK}`), (link) => ({
      href: new URL(link.getAttribute('href'), url).href,
      status: link.closest('tr').querySelector('.c-status').textContent.trim(),
    }))
  }

  async function fetchPage(href) {
    const response = await fetch(href, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`禅道返回 HTTP ${response.status}`)
    return { doc: new DOMParser().parseFromString(await response.text(), 'text/html'), url: response.url }
  }

  function normalizePath(path) {
    return path.replace(/%[\da-f]{2}/gi, (part) => part.toUpperCase())
  }

  function highlightPrototypePages() {
    const pages = new Set(GM_getValue(PROTOTYPE_PAGES_KEY, []))
    const folder = normalizePath(new URL('.', location.href).pathname)
    if (![...pages].some((path) => path.startsWith(folder))) return

    const style = document.createElement('style')
    style.textContent = `
      #sitemapTreeContainer .zentao-unfinished-task .sitemapPageName {
        background: #ffeb9e;
        color: #613b00;
        font-weight: 600;
        border-radius: 3px;
      }
    `
    document.head.append(style)

    const highlight = () => {
      for (const link of document.querySelectorAll('#sitemapTreeContainer .sitemapPageLink[nodeurl]')) {
        const path = normalizePath(new URL(link.getAttribute('nodeurl'), location.href).pathname)
        if (!pages.has(path) || link.classList.contains('zentao-unfinished-task')) continue
        link.classList.add('zentao-unfinished-task')

        // 用原型自己的展开控件显示任务，保留目录的交互状态。
        for (let node = link.closest('.sitemapNode').parentElement; node; node = node.parentElement) {
          if (!node.matches('.sitemapExpandableNode')) continue
          node.querySelector(':scope > div .sitemapPlus')?.closest('.sitemapPlusMinusLink').click()
        }
      }
    }
    new MutationObserver(highlight).observe(document.body, { childList: true, subtree: true })
    highlight()
  }
})()
