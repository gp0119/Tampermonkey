// ==UserScript==
// @name         禅道打开需求链接
// @namespace    http://tampermonkey.net/
// @version      1.8.4
// @description  在禅道任务列表查看需求链接、项目截止日期及同需求的后端和测试指派人，并在原型目录标记任务状态
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @match        *://zentao.chaomeifan.com/*
// @match        *://redmine.chaomeifan.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// ==/UserScript==
// https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js?v=1.8.4

;(function () {
  'use strict'

  const PROTOTYPE_HOST = 'redmine.chaomeifan.com'
  const PROTOTYPE_COHORT_KEY = 'prototypeTaskPages:'
  const DEADLINE_PARAM = 'zentaoDeadline'
  const DETAIL_TITLE = '.detail > .detail-title'
  const TASK_LINK = '.c-name a[href*="/task-view-"]'
  const UNFINISHED = ['wait', 'doing', 'pause']

  if (location.hostname === PROTOTYPE_HOST) {
    if (window.top === window) enhancePrototypePages()
    return
  }

  if (document.querySelector('a.btn-active-text[href$="my-task-assignedTo.html"]')) {
    const table = document.querySelector('#tasktable')
    if (!table) return
    const projectDeadlines = readProjectDeadlines()
    addProjectDeadlines(table, projectDeadlines)
    addTaskAssignees(table, projectDeadlines)
    const buttons = addTaskButtons(table)
    layoutTaskTable(table)
    if (!buttons.size) return
    syncTaskLinks(buttons, projectDeadlines).catch((error) => {
      const message = document.createElement('p')
      message.textContent = '部分需求链接未同步，请刷新页面重试。'
      message.setAttribute('role', 'status')
      table.before(message)
      console.error('加载禅道需求链接失败', error)
    })
  } else {
    for (const title of document.querySelectorAll(DETAIL_TITLE)) {
      const link = getRequirementLink(title, location.href)
      if (link) addDetailButton(title, link)
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
    return button
  }

  async function addDetailButton(title, link) {
    const button = createLinkButton(link.url, link.target)
    const project = document.querySelector('.breadcrumb a[href*="/project-browse-"]')
    const id = project?.pathname.match(/\/project-browse-(\d+)\.html$/)?.[1]
    const prototype = prototypePageReference(new URL(link.url))
    if (id && prototype) {
      const projectDeadlines = readProjectDeadlines()
      const deadline = (await projectDeadlines)?.get(id)
      if (deadline) {
        button.href = linkWithDeadline(link.url, deadline, prototype.part)
        const refresh = () =>
          syncTaskLinks(new Map(), projectDeadlines, deadline).catch((error) => {
            console.error('加载同截止日期的禅道任务失败', error)
          })
        if (GM_getValue(PROTOTYPE_COHORT_KEY + deadline)) {
          button.addEventListener('click', refresh, { once: true })
        } else {
          refresh()
        }
      }
    }
    title.style.display = 'flex'
    title.style.alignItems = 'center'
    title.style.columnGap = '8px'
    title.append(button)
  }

  async function readProjectDeadlines() {
    try {
      const { projects } = await fetchZenTao(new URL('my-project.json', location.href))
      return new Map(Object.values(projects).flatMap(({ id, end }) => (/^\d{4}-\d{2}-\d{2}$/.test(end) && end !== '0000-00-00' ? [[String(id), end]] : [])))
    } catch (error) {
      console.error('读取禅道项目截止日期失败', error)
      return null
    }
  }

  function layoutTaskTable(table) {
    const widths = {
      id: '88px',
      pri: '40px',
      project: '160px',
      name: 'auto',
      openedBy: '72px',
      assignedTo: '72px',
      finishedBy: '80px',
      estimate: '48px',
      consumed: '48px',
      left: '48px',
      status: '80px',
      截止日期: '100px',
      后端: '72px',
      测试: '72px',
      操作: '176px',
    }
    for (const header of table.tHead.rows[0].cells) {
      const field = header.querySelector('a[href]')?.getAttribute('href').match(/-([a-z]+)_(?:asc|desc)(?:-|\.html)/i)?.[1]
      const width = widths[field ?? header.textContent.trim()]
      if (width) header.style.setProperty('width', width, 'important')
    }
    table.style.tableLayout = 'fixed'
    table.style.width = '100%'
    table.style.minWidth = '1480px'
    const container = document.createElement('div')
    container.style.overflowX = 'auto'
    table.before(container)
    container.append(table)
  }

  async function addProjectDeadlines(table, projectDeadlines) {
    const projectHeader = table.querySelector('thead .c-project')
    if (!projectHeader) return

    const header = document.createElement('th')
    header.scope = 'col'
    header.className = 'w-100px'
    header.textContent = '截止日期'
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
      header.title = '截止日期读取失败，请刷新页面重试。'
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
      row.style.minWidth = '0'
      taskLink.style.flex = '1 1 0%'
      taskLink.style.minWidth = '0'
      taskLink.style.overflow = 'hidden'
      taskLink.style.textOverflow = 'ellipsis'
      taskLink.title = taskLink.textContent.trim()
      taskLink.before(row)
      row.append(taskLink, button)
      buttons.set(id, button)
    }
    return buttons
  }

  async function addTaskAssignees(table, projectDeadlines) {
    const assignedHeader = table.querySelector('thead a[href*="-assignedTo_"]')?.closest('th')
    if (!assignedHeader) return

    const roles = [
      { label: '后端', matches: (task) => task.type === 'devel' && !task.name.includes('【前端】') },
      { label: '测试', matches: (task) => task.type === 'test' },
    ]
    assignedHeader.after(
      ...roles.map(({ label }) => {
        const header = document.createElement('th')
        header.scope = 'col'
        header.className = 'w-100px'
        header.textContent = label
        return header
      })
    )

    const rows = Array.from(table.querySelectorAll(`tbody ${TASK_LINK}`), (link) => {
      const row = link.closest('tr')
      const id = link.pathname.match(/\/task-view-(\d+)\.html$/)[1]
      const project = row.querySelector('.c-project a')?.pathname.match(/\/project-browse-(\d+)\.html$/)?.[1]
      const cells = roles.map(() => {
        const cell = document.createElement('td')
        cell.textContent = '—'
        cell.style.whiteSpace = 'normal'
        cell.style.overflowWrap = 'anywhere'
        return cell
      })
      row.cells[assignedHeader.cellIndex].after(...cells)
      return { id, project, cells }
    })

    const deadlines = await projectDeadlines
    if (!deadlines) {
      for (const { cells } of rows) {
        for (const cell of cells) {
          cell.textContent = '读取失败'
          cell.title = '截止日期读取失败，请刷新页面重试。'
        }
      }
      return
    }
    const today = new Date().setHours(0, 0, 0, 0)
    const upcomingRows = rows.filter(({ project }) => {
      const deadline = deadlines.get(project)
      return deadline && new Date(`${deadline}T00:00:00`).getTime() >= today
    })

    await Promise.all(
      Object.entries(Object.groupBy(upcomingRows, (row) => row.project)).map(async ([project, rows]) => {
        for (const { cells } of rows) {
          for (const cell of cells) cell.textContent = '…'
        }
        try {
          const { tasks, users } = await readTasks(`project-task-${project}-all-0-id_desc`)
          const tasksById = new Map(tasks.map((task) => [String(task.id), task]))
          const tasksByStory = Object.groupBy(
            tasks.filter((task) => Number(task.story) > 0),
            (task) => task.story
          )
          for (const { id, cells } of rows) {
            const related = tasksByStory[tasksById.get(id)?.story] ?? []
            cells.forEach((cell, index) => {
              const names = related.filter(roles[index].matches).map((task) => {
                const account = task.finishedBy || task.assignedTo
                return users[account] || account || '未指派'
              })
              cell.textContent = [...new Set(names)].join('、') || '—'
            })
          }
        } catch (error) {
          for (const { cells } of rows) {
            for (const cell of cells) cell.textContent = '读取失败'
          }
          console.error('读取同需求的任务指派人失败', error)
        }
      })
    )
  }

  function addPrototypeLabel(button, folder) {
    if (button.previousElementSibling?.matches('[data-prototype-label]')) button.previousElementSibling.remove()
    const segments = folder.split('/').filter(Boolean).slice(-2)
    if (!segments.length) return

    let name = segments.join(' · ')
    try {
      name = segments.map(decodeURIComponent).join(' · ')
    } catch {
      // 需求地址包含无法解码的路径时，显示原路径名称。
    }
    const label = document.createElement('span')
    label.className = 'label label-light'
    label.dataset.prototypeLabel = ''
    label.textContent = name
    label.title = name
    Object.assign(label.style, {
      marginInlineStart: 'auto',
      maxWidth: 'min(24%, 160px)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
    button.style.marginInlineStart = '0'
    button.before(label)
  }

  async function syncTaskLinks(buttons, projectDeadlines, selectedDate) {
    const [{ tasks }, deadlines] = await Promise.all([readTasks('my-task-assignedTo-id_desc'), projectDeadlines])
    const visibleDates = tasks
      .filter((task) => buttons.has(String(task.id)))
      .map((task) => deadlines?.get(String(task.project)))
      .filter(Boolean)
    const cohorts = new Map([...new Set(selectedDate ? [selectedDate] : visibleDates)].map((date) => [date, {}]))
    const relevantTasks = tasks.filter((task) => Number(task.story) > 0 && (buttons.has(String(task.id)) || cohorts.has(deadlines?.get(String(task.project)))))
    const groups = Object.groupBy(relevantTasks, (task) => `${task.story}/${task.storyVersion}/${task.latestStoryVersion}`)
    const jobs = Object.entries(groups)
      .map(([version, tasks]) => ({
        version,
        tasks,
        visible: tasks.some((task) => buttons.has(String(task.id))),
      }))
      .sort((a, b) => Number(b.visible) - Number(a.visible))

    const applyLink = (tasks, link) => {
      if (!link) return
      const prototype = prototypePageReference(new URL(link.url))
      for (const task of tasks) {
        const end = deadlines?.get(String(task.project))
        const button = buttons.get(String(task.id))
        if (button) {
          button.href = prototype && end ? linkWithDeadline(link.url, end, prototype.part) : link.url
          button.target = link.target || '_blank'
          button.removeAttribute('title')
          if (prototype) addPrototypeLabel(button, prototype.folder)
        }
        const pages = cohorts.get(end)
        if (!prototype || !pages) continue

        // 同一日期的多个任务指向同一原型时，优先标记未完成的任务。
        const { key, path } = prototype
        const state = UNFINISHED.includes(task.status) ? 2 : Number(task.status === 'done')
        pages[key] = { path, state: Math.max(pages[key]?.state ?? 0, state) }
      }
    }
    const publish = () => {
      for (const [date, pages] of cohorts) GM_setValue(PROTOTYPE_COHORT_KEY + date, pages)
    }

    // 过期的缓存先用于显示，避免刷新期间或请求失败时清空原型页的标记。
    const pending = jobs.filter(({ version, tasks }) => {
      const cached = GM_getValue(`storyLink:${version}`)
      if (cached) applyLink(tasks, cached.link)
      return !cached || Date.now() - cached.savedAt > 7 * 24 * 60 * 60 * 1000
    })
    publish()
    pruneStoredValues(new Set([...jobs.map(({ version }) => `storyLink:${version}`), ...[...cohorts.keys()].map((date) => PROTOTYPE_COHORT_KEY + date)]))

    const concurrency = 6
    let next = 0
    let completed = 0
    let failed = false
    const syncPendingLinks = async () => {
      while (next < pending.length) {
        const { version, tasks } = pending[next++]
        try {
          const href = new URL(`task-view-${tasks[0].id}.json`, location.href)
          const { task } = await fetchZenTao(href)
          const doc = new DOMParser().parseFromString(task.storySpec ?? '', 'text/html')
          const link = parseRequirementLink(doc, href) ?? null
          GM_setValue(`storyLink:${version}`, { link, savedAt: Date.now() })
          applyLink(tasks, link)
        } catch {
          failed = true
        }
        completed++
        // 每完成一批就同步，已打开的原型页可以逐步更新。
        if (completed % 24 === concurrency || completed === pending.length) publish()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, syncPendingLinks))
    if (failed) throw new Error('部分任务详情读取失败')
  }

  function pruneStoredValues(keepKeys) {
    const expiredAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    for (const key of GM_listValues()) {
      if (keepKeys.has(key)) continue
      const date = key.match(/^prototypeTask(?:Pages|Cohort):(\d{4}-\d{2}-\d{2})$/)?.[1]
      const savedAt = date ? Date.parse(`${date}T00:00:00`) : key.startsWith('storyLink:') ? GM_getValue(key).savedAt : undefined
      if (savedAt < expiredAt) GM_deleteValue(key)
    }
  }

  async function readTasks(path) {
    const first = await fetchZenTao(new URL(`${path}-0-2000-1.json`, location.href))
    const { recTotal, recPerPage, pageTotal } = first.pager
    // 项目列表把子任务嵌在父任务中，分页总数仍包含这些子任务。
    const flattenTasks = (tasks) => Object.values(tasks).flatMap((task) => [task, ...flattenTasks(task.children ?? {})])
    const tasks = flattenTasks(first.tasks)
    for (let page = 2; page <= Number(pageTotal); page++) {
      const href = new URL(`${path}-${recTotal}-${recPerPage}-${page}.json`, location.href)
      tasks.push(...flattenTasks((await fetchZenTao(href)).tasks))
    }
    if (new Set(tasks.map((task) => task.id)).size !== Number(recTotal)) throw new Error('分页中的任务数与列表总数不符')
    return { tasks, users: first.users }
  }

  async function fetchZenTao(href) {
    const response = await fetch(href, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`禅道返回 HTTP ${response.status}`)
    const result = await response.json()
    if (result.status !== 'success') throw new Error('禅道接口请求失败')
    return JSON.parse(result.data)
  }

  function prototypePageReference(url) {
    if (url.hostname !== PROTOTYPE_HOST) return
    const hash = new URLSearchParams(url.hash.slice(1))
    const part = hash.has('p') || (!url.searchParams.has('p') && hash.has('id')) ? 'hash' : 'search'
    const params = part === 'hash' ? hash : url.searchParams
    const id = params.get('id')
    const page = params.get('p')
    if (!id && !page) return

    const folder = normalizePath(new URL('.', url).pathname)
    const path = page ? normalizePath(new URL(`${encodeURIComponent(page)}.html`, url).pathname) : null
    return { folder, part, path, key: id ? `${folder}#${id}` : path }
  }

  function linkWithDeadline(href, deadline, part) {
    const url = new URL(href)
    const parameter = `${DEADLINE_PARAM}=${deadline}`
    const existing = new RegExp(`([?&#])${DEADLINE_PARAM}=[^&]*`)
    url[part] = existing.test(url[part]) ? url[part].replace(existing, `$1${parameter}`) : `${url[part]}&${parameter}`
    return url.href
  }

  function normalizePath(path) {
    return path.replace(/%[\da-f]{2}/gi, (part) => part.toUpperCase())
  }

  function readPrototypePathsById(url, folder) {
    const roots = unsafeWindow.$axure?.document?.sitemap?.rootNodes
    if (!roots) return

    const paths = new Map()
    const nodes = [...roots]
    while (nodes.length) {
      const node = nodes.pop()
      if (node.id && node.url) paths.set(`${folder}#${node.id}`, normalizePath(new URL(node.url, url).pathname))
      if (node.children) nodes.push(...node.children)
    }
    return paths
  }

  function enhancePrototypePages() {
    const url = new URL(location.href)
    const folder = normalizePath(new URL('.', url).pathname)
    const selectionKey = `${DEADLINE_PARAM}:${folder}`
    const deadline = new URLSearchParams(url.hash.slice(1)).get(DEADLINE_PARAM) ?? url.searchParams.get(DEADLINE_PARAM) ?? sessionStorage.getItem(selectionKey)
    const cohortKey = /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? PROTOTYPE_COHORT_KEY + deadline : null
    let tree = document.getElementById('sitemapTreeContainer')
    if (!cohortKey && !tree && !document.getElementById('mainFrame')) return

    let stopSidebarLayout = tree ? mountPrototypeSidebar(tree) : undefined
    let pages
    let pathsById
    if (cohortKey) {
      sessionStorage.setItem(selectionKey, deadline)
      pages = GM_getValue(cohortKey) ?? GM_getValue('prototypeTaskCohort:' + deadline, {})
      addPrototypeStatusStyles()
    }

    const labels = ['已关闭或取消', '已完成', '未完成']
    const highlight = () => {
      if (!tree) return
      pathsById ??= readPrototypePathsById(url, folder)
      const statesByPath = new Map()
      for (const [key, page] of Object.entries(pages)) {
        // 页名可能改过。按目录里的 ID 找到现用地址，再兼容旧缓存和无 ID 的链接。
        const legacy = typeof page === 'number'
        const path = legacy ? key : (pathsById?.get(key) ?? page.path)
        if (!path) continue
        const state = legacy ? page : page.state
        statesByPath.set(path, Math.max(statesByPath.get(path) ?? 0, state))
      }
      for (const link of tree.querySelectorAll('.sitemapPageLink[nodeurl]')) {
        const path = normalizePath(new URL(link.getAttribute('nodeurl'), location.href).pathname)
        const previous = link.dataset.zentaoTaskState
        const state = statesByPath.get(path)
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

        expandPrototypeParents(link)
      }
    }
    let scheduled = false
    const scheduleHighlight = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        highlight()
      })
    }
    new MutationObserver((mutations) => {
      const previousTree = tree
      tree = document.getElementById('sitemapTreeContainer')
      if (tree !== previousTree) {
        stopSidebarLayout?.()
        stopSidebarLayout = tree ? mountPrototypeSidebar(tree) : undefined
      }
      if (!tree || !cohortKey) return

      // 原型的目录数据可能晚于 DOM 就绪。
      const previousPaths = pathsById
      pathsById ??= readPrototypePathsById(url, folder)
      if (tree !== previousTree || pathsById !== previousPaths || mutations.some(({ target }) => tree.contains(target))) {
        scheduleHighlight()
      }
    }).observe(document.body, { childList: true, subtree: true })
    if (!cohortKey) return
    GM_addValueChangeListener(cohortKey, (_key, _oldPages, newPages) => {
      pages = newPages
      scheduleHighlight()
    })
    highlight()
  }

  function mountPrototypeSidebar(tree) {
    const panel = tree.closest('.leftPanel')
    const splitter = document.getElementById('lsplitbar')
    let autoWidth = true
    let revealedPage
    let frame

    const disableAutoWidth = () => {
      autoWidth = false
    }
    splitter?.addEventListener('pointerdown', disableAutoWidth, { once: true })

    const layout = () => {
      frame = undefined
      if (!tree.clientWidth || !tree.clientHeight) {
        revealedPage = undefined
        return
      }

      const page = tree.querySelector('.sitemapHighlight')
      if (page && page !== revealedPage) expandPrototypeParents(page)
      if (autoWidth && panel) widenPrototypeSidebar(panel, tree)

      if (!page || page === revealedPage || !page.offsetHeight) return
      const row = page.getBoundingClientRect()
      const top = tree.getBoundingClientRect().top + tree.clientTop
      const bottom = top + tree.clientHeight
      const delta = row.top < top ? row.top - top : Math.max(0, row.bottom - bottom)
      const previousScroll = tree.scrollTop
      if (delta) tree.scrollTop += delta
      // 分组展开期间，当前的滚动范围可能还到不了目标行。
      if (Math.abs(tree.scrollTop - previousScroll - delta) < 1) revealedPage = page
    }
    const scheduleLayout = () => {
      frame ??= requestAnimationFrame(layout)
    }

    const selectionObserver = new MutationObserver(scheduleLayout)
    selectionObserver.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const sizeObserver = new ResizeObserver(scheduleLayout)
    sizeObserver.observe(tree)
    const list = tree.querySelector('.sitemapTree')
    if (list) sizeObserver.observe(list)
    window.addEventListener('resize', scheduleLayout)
    scheduleLayout()

    return () => {
      selectionObserver.disconnect()
      sizeObserver.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      splitter?.removeEventListener('pointerdown', disableAutoWidth)
      window.removeEventListener('resize', scheduleLayout)
    }
  }

  function widenPrototypeSidebar(panel, tree) {
    const overflow = tree.scrollWidth - tree.clientWidth
    if (overflow <= 0) return
    const player = unsafeWindow.$axure?.player
    if (!player?.resizeContent || player.isMobileMode?.()) return

    const rightWidth = document.querySelector('.rightPanel')?.offsetWidth ?? 0
    const maxWidth = Math.floor(Math.min(window.innerWidth * 0.45, window.innerWidth - rightWidth - 320))
    const width = panel.offsetWidth
    const fittedWidth = Math.min(width + overflow, maxWidth)
    if (fittedWidth <= width) return

    panel.style.width = `${fittedWidth}px`
    player.resizeContent()
  }

  function expandPrototypeParents(row) {
    // 通过 Axure 的展开控件同步目录的交互状态。
    for (let node = row.closest('.sitemapNode').parentElement; node; node = node.parentElement) {
      if (!node.matches('.sitemapExpandableNode')) continue
      node.querySelector(':scope > div .sitemapPlusMinusLink:has(.sitemapPlus)')?.click()
    }
  }

  function addPrototypeStatusStyles() {
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
  }
})()
