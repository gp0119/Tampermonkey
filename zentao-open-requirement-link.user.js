// ==UserScript==
// @name         禅道打开需求链接
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  在禅道任务列表查看需求链接和项目截止日期，并在原型目录标记任务状态
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @match        *://zentao.chaomeifan.com/*
// @match        *://redmine.chaomeifan.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

;(function () {
  'use strict'

  const PROTOTYPE_HOST = 'redmine.chaomeifan.com'
  const PROTOTYPE_PAGES_KEY = 'prototypeTaskDeadlines'
  const DETAIL_TITLE = '.detail > .detail-title'
  const TASK_LINK = '.c-name a[href*="/task-view-"]'
  const UNFINISHED = ['wait', 'doing', 'pause']
  const PROJECT_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })

  if (location.hostname === PROTOTYPE_HOST) {
    if (window.top === window) highlightPrototypePages()
    return
  }

  if (document.querySelector('a.btn-active-text[href$="my-task-assignedTo.html"]')) {
    const table = document.querySelector('#tasktable')
    if (!table) {
      GM_setValue(PROTOTYPE_PAGES_KEY, {})
      return
    }
    const projectDeadlines = readProjectDeadlines()
    addProjectDeadlines(table, projectDeadlines)
    syncTaskLinks(table, addTaskButtons(table), projectDeadlines).catch((error) => {
      const message = document.createElement('p')
      message.textContent = '部分需求链接未同步，请刷新页面重试。'
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
      title.append(createLinkButton(link.url, link.target))
    }
  }

  function getRequirementLink(title, baseUrl) {
    if (title.textContent.trim() !== '需求描述') return
    const content = title.nextElementSibling
    if (!content?.matches('.detail-content')) return
    return parseRequirementLink(content, baseUrl)
  }

  function parseRequirementLink(content, baseUrl) {
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
    return { url: url.href, target: link.target }
  }

  function createLinkButton(href, target) {
    const button = document.createElement('a')
    button.href = href
    button.target = target
    button.rel = 'noopener'
    button.className = 'btn btn-default btn-sm'
    button.style.marginInlineStart = 'auto'
    button.textContent = '查看'
    button.title = '查看需求链接'
    return button
  }

  async function readProjectDeadlines() {
    try {
      const { projects } = await fetchZenTao(new URL('my-project.json', location.href))
      return new Map(Object.values(projects).flatMap(({ id, end }) => (
        end && end !== '0000-00-00' ? [[String(id), end]] : []
      )))
    } catch (error) {
      console.error('读取禅道项目截止日期失败', error)
      return null
    }
  }

  async function addProjectDeadlines(table, projectDeadlines) {
    const projectHeader = table.querySelector('thead .c-project')
    if (!projectHeader) return

    const header = document.createElement('th')
    header.scope = 'col'
    header.className = 'w-100px'
    header.textContent = '项目截止日期'
    projectHeader.after(header)

    const rows = Array.from(table.querySelectorAll('tbody .c-project'), (projectCell) => {
      const id = projectCell.querySelector('a')?.pathname.match(/\/project-browse-(\d+)\.html$/)?.[1]
      const cell = document.createElement('td')
      cell.textContent = '—'
      projectCell.after(cell)
      return { id, cell }
    })
    if (!rows.some(({ id }) => id)) return

    const deadlines = await projectDeadlines
    if (!deadlines) {
      header.title = '项目截止日期读取失败，请刷新页面重试。'
      return
    }
    for (const { id, cell } of rows) {
      cell.textContent = deadlines.get(id) ?? '—'
    }
  }

  function addTaskButtons(table) {
    const buttons = new Map()
    for (const taskLink of table.querySelectorAll(`tbody ${TASK_LINK}`)) {
      const [, id] = taskLink.pathname.match(/\/task-view-(\d+)\.html$/)
      const button = createLinkButton(taskLink.href, '_blank')
      button.title = '查看任务详情'
      button.style.flexShrink = '0'
      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.alignItems = 'center'
      row.style.columnGap = '8px'
      taskLink.style.overflow = 'hidden'
      taskLink.style.textOverflow = 'ellipsis'
      taskLink.before(row)
      row.append(taskLink, button)
      buttons.set(id, button)
    }
    return buttons
  }

  async function syncTaskLinks(table, buttons, projectDeadlines) {
    const [tasks, deadlines] = await Promise.all([readAssignedTasks(table, buttons.size), projectDeadlines])
    const today = PROJECT_DATE.format(Date.now())
    const relevantTasks = tasks.filter((task) => Number(task.story) > 0 && (
      buttons.has(String(task.id)) || (deadlines?.get(String(task.project)) ?? '') >= today
    ))
    const groups = Object.groupBy(relevantTasks, (task) => (
      `${task.story}/${task.storyVersion}/${task.latestStoryVersion}`
    ))
    const jobs = Object.entries(groups).map(([version, tasks]) => ({
      version,
      tasks,
      visible: tasks.some((task) => buttons.has(String(task.id))),
    })).sort((a, b) => Number(b.visible) - Number(a.visible))

    const pages = {}
    const applyLink = (tasks, link) => {
      if (!link) return
      const path = prototypePagePath(new URL(link.url))
      for (const task of tasks) {
        const button = buttons.get(String(task.id))
        if (button) {
          button.href = link.url
          button.target = link.target || '_blank'
          button.title = '查看需求链接'
        }
        const end = deadlines?.get(String(task.project))
        if (!path || !end || end < today) continue

        // 同一原型可能关联多个项目，分别保留各任务状态的最晚截止日期。
        const state = UNFINISHED.includes(task.status) ? 2 : Number(task.status === 'done')
        const page = (pages[path] ??= {})
        if (end > (page[state] ?? '')) page[state] = end
      }
    }

    const pending = jobs.filter(({ version, tasks }) => {
      const cached = GM_getValue(`storyLink:${version}`)
      if (!cached || Date.now() - cached.savedAt > 7 * 24 * 60 * 60 * 1000) return true
      applyLink(tasks, cached.link)
      return false
    })
    if (deadlines) GM_setValue(PROTOTYPE_PAGES_KEY, pages)

    let failed = false
    for (let index = 0; index < pending.length; index += 6) {
      const results = await Promise.allSettled(pending.slice(index, index + 6).map(async ({ version, tasks }) => {
        const href = new URL(`task-view-${tasks[0].id}.json`, location.href)
        const { task } = await fetchZenTao(href)
        const doc = new DOMParser().parseFromString(task.storySpec ?? '', 'text/html')
        const link = parseRequirementLink(doc, href) ?? null
        GM_setValue(`storyLink:${version}`, { link, savedAt: Date.now() })
        applyLink(tasks, link)
      }))
      failed ||= results.some((result) => result.status === 'rejected')
      // 提前同步当前页和首批任务，打开的原型页会随后台扫描更新。
      if (deadlines && (index % 24 === 0 || index + 6 >= pending.length)) GM_setValue(PROTOTYPE_PAGES_KEY, pages)
    }
    if (failed) throw new Error('部分任务详情读取失败')
  }

  async function readAssignedTasks(table, visibleCount) {
    const pager = table.closest('form').querySelector('ul.pager[data-link-creator]')
    const total = Number(pager?.dataset.recTotal ?? visibleCount)
    if (total === 0) return []

    const pageSize = pager
      ? Math.max(...Array.from(pager.querySelectorAll('[data-size]'), (item) => Number(item.dataset.size)))
      : total
    const tasks = []
    for (let page = 1; page <= Math.ceil(total / pageSize); page++) {
      const href = pager
        ? pager.dataset.linkCreator.replace('{recPerPage}', String(pageSize)).replace('{page}', String(page))
        : location.pathname
      const data = await fetchZenTao(href.replace(/\.html$/, '.json'))
      tasks.push(...Object.values(data.tasks))
    }
    if (new Set(tasks.map((task) => task.id)).size !== total) throw new Error('分页中的任务数与列表总数不符')
    return tasks
  }

  async function fetchZenTao(href) {
    const response = await fetch(href, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`禅道返回 HTTP ${response.status}`)
    const result = await response.json()
    if (result.status !== 'success') throw new Error('禅道接口请求失败')
    return JSON.parse(result.data)
  }

  function prototypePagePath(url) {
    if (url.hostname !== PROTOTYPE_HOST) return
    const page = new URLSearchParams(url.hash.slice(1)).get('p') ?? url.searchParams.get('p')
    if (page) return normalizePath(new URL(`${encodeURIComponent(page)}.html`, url).pathname)
  }

  function normalizePath(path) {
    return path.replace(/%[\da-f]{2}/gi, (part) => part.toUpperCase())
  }

  function highlightPrototypePages() {
    let pages = GM_getValue(PROTOTYPE_PAGES_KEY, {})
    const url = new URL(location.href)
    const folder = normalizePath(new URL('.', url).pathname)
    if (!prototypePagePath(url) && !Object.keys(pages).some((path) => path.startsWith(folder))) return

    const labels = ['已关闭或取消', '已完成', '未完成']
    const statePriority = [2, 1, 0]
    const style = document.createElement('style')
    style.textContent = `
      #sitemapTreeContainer [data-zentao-task-state] .sitemapPageName {
        font-weight: 600;
        border-radius: 3px;
      }
      #sitemapTreeContainer [data-zentao-task-state="2"] .sitemapPageName {
        background: #ffeb9e;
        color: #613b00;
      }
      #sitemapTreeContainer [data-zentao-task-state="1"] .sitemapPageName {
        background: #d1f0d8;
        color: #185528;
      }
      #sitemapTreeContainer [data-zentao-task-state="0"] .sitemapPageName {
        background: #e9ecef;
        color: #424a53;
      }
    `
    document.head.append(style)

    const highlight = () => {
      const today = PROJECT_DATE.format(Date.now())
      for (const link of document.querySelectorAll('#sitemapTreeContainer .sitemapPageLink[nodeurl]')) {
        const path = normalizePath(new URL(link.getAttribute('nodeurl'), location.href).pathname)
        const previous = link.dataset.zentaoTaskState
        const page = pages[path]
        const state = page && statePriority.find((priority) => page[priority] >= today)
        if (state === undefined) {
          if (previous !== undefined) {
            delete link.dataset.zentaoTaskState
            link.removeAttribute('title')
          }
          continue
        }
        if (previous === String(state)) continue
        link.dataset.zentaoTaskState = String(state)
        link.title = labels[state]
        if (previous !== undefined) continue

        // 用原型自己的展开控件显示任务，保留目录的交互状态。
        for (let node = link.closest('.sitemapNode').parentElement; node; node = node.parentElement) {
          if (!node.matches('.sitemapExpandableNode')) continue
          node.querySelector(':scope > div .sitemapPlusMinusLink:has(.sitemapPlus)')?.click()
        }
      }
    }
    new MutationObserver(highlight).observe(document.body, { childList: true, subtree: true })
    GM_addValueChangeListener(PROTOTYPE_PAGES_KEY, (_key, _oldPages, newPages) => {
      pages = newPages
      highlight()
    })
    highlight()
    refreshAtMidnight()

    function refreshAtMidnight() {
      const now = Date.now()
      const midnight = Date.parse(`${PROJECT_DATE.format(now)}T00:00:00+08:00`) + 24 * 60 * 60 * 1000
      setTimeout(() => {
        highlight()
        refreshAtMidnight()
      }, midnight - now)
    }
  }
})()
