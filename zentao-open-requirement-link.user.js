// ==UserScript==
// @name         禅道打开需求链接
// @namespace    http://tampermonkey.net/
// @version      2.1.5
// @description  在禅道任务列表查看需求链接、项目截止日期和协作人员，批量完成任务，并在原型目录标记任务状态
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @match        *://zentao.chaomeifan.com/*
// @match        *://redmine.chaomeifan.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// ==/UserScript==
// https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js?v=2.1.5

;(function () {
  'use strict'

  const PROTOTYPE_HOST = 'redmine.chaomeifan.com'
  const PROTOTYPE_COHORT_KEY = 'prototypeTaskPages:'
  const DEADLINE_PARAM = 'zentaoDeadline'
  const ASSIGNED_TASKS_PAGE = /\/my-work-task(?:-assignedTo(?:-.*)?)?\.html$/
  const DETAIL_TITLE = '.detail-section > .detail-section-title'
  const ROLES = ['前端', '后端', '测试']
  const UNFINISHED = ['wait', 'doing', 'pause']
  const pendingZenTaoRequests = new Map()
  const zenTaoRequestQueue = []
  const storyLinkRequests = new Map()
  const cohortRequests = new Map()
  let projectDeadlines
  let activeZenTaoRequests = 0
  let batchFinishing = false

  if (location.hostname === PROTOTYPE_HOST) {
    enhancePrototypePages()
    return
  }

  observeZenTao()

  function observeZenTao() {
    const frames = new WeakSet()
    const documents = new WeakSet()
    const observedTitles = new WeakSet()
    const taskProjects = new Map()

    function observe(doc, pageWindow) {
      if (!doc || documents.has(doc)) return
      documents.add(doc)
      let frame
      let gridState
      function update() {
        frame = undefined
        if (doc === document) {
          // 禅道外壳在同源 iframe 中打开各应用，切换应用时会保留已经打开的 iframe。
          for (const app of doc.querySelectorAll('iframe[id^="appIframe-"]')) {
            const connect = () => observe(app.contentDocument, pageWindow.frames[app.name])
            if (!frames.has(app)) {
              frames.add(app)
              app.addEventListener('load', connect)
            }
            connect()
          }
        }
        if (ASSIGNED_TASKS_PAGE.test(doc.location.pathname)) {
          gridState = enhanceTaskTable(doc, pageWindow, gridState, taskProjects)
        }
        for (const title of doc.querySelectorAll(DETAIL_TITLE)) {
          if (observedTitles.has(title)) continue
          const link = getRequirementLink(title, doc.location.href)
          if (!link) continue
          observedTitles.add(title)
          const scope = title.closest('.modal-content') ?? doc
          const taskID = scope.querySelector('.detail-header [id^="zin_task_view_"] .label-id')?.textContent.trim()
          const project = scope.querySelector('a[href*="/project-view-"], a[href*="/project-browse-"]')
          const id = taskProjects.get(taskID) ?? project?.pathname.match(/\/project-(?:view|browse)-(\d+)\.html$/)?.[1]
          addDetailButton(title, link, id)
        }
      }
      // 禅道会用 document.open() 替换 iframe 的 body。
      new MutationObserver(() => {
        frame ??= requestAnimationFrame(update)
      }).observe(doc, { childList: true, subtree: true })
      update()
    }
    observe(document, unsafeWindow)
  }

  function getRequirementLink(title, baseUrl) {
    if (!/^(?:需求描述|\[需求描述\])$/.test(title.textContent.trim())) return
    const content = title.nextElementSibling
    if (!content?.matches('.detail-section-content')) return
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
    button.className = 'btn size-sm flex-none'
    button.textContent = '查看'
    return button
  }

  async function addDetailButton(title, link, project) {
    const button = createLinkButton(link.url, link.target || '_blank')
    const prototype = prototypePageReference(new URL(link.url))
    if (!prototype) button.textContent = '查看需求'
    button.style.marginInlineStart = '8px'
    title.append(button)
    if (project && prototype) {
      // 截止日期就绪前不可点击，否则原型页拿不到日期参数，打开后也无法再补上。
      button.removeAttribute('href')
      button.classList.add('disabled')
      button.setAttribute('aria-disabled', 'true')
      const deadline = (await getProjectDeadlines())?.get(project)
      button.href = deadline ? linkWithDeadline(link.url, deadline, prototype.part) : link.url
      button.classList.remove('disabled')
      button.removeAttribute('aria-disabled')
      if (deadline) {
        const refresh = () => syncPrototypeCohort(deadline).catch(reportCohortError)
        if (GM_getValue(PROTOTYPE_COHORT_KEY + deadline)) {
          button.addEventListener('click', refresh, { once: true })
        } else {
          refresh()
        }
      }
    }
  }

  function getProjectDeadlines() {
    return projectDeadlines ??= readProjectDeadlines()
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

  function enhanceTaskTable(doc, pageWindow, previous, taskProjects) {
    const grid = doc.getElementById('table-my-work')
    const holder = grid?.parentElement
    const table = holder && pageWindow.zui?.DTable?.get(holder)
    if (!table) return

    const { data, cols, onRenderCell, bordered } = table.options
    const alreadyEnhanced = previous?.table === table && previous.data === data && previous.renderCell === onRenderCell
    if (alreadyEnhanced || !data.length) {
      if (!bordered) table.render({ bordered: true })
      return alreadyEnhanced ? previous : undefined
    }

    const nativeRenderCell = previous?.renderCell === onRenderCell ? previous.nativeRenderCell : onRenderCell
    const account = pageWindow.config.account
    const tasks = data.map((task) => ({ ...task, status: task.rawStatus }))
    const mine = tasks.filter((task) => task.assignedTo === account)
    const currentRole = ROLES.find((role) => mine.some(({ name }) => name.includes(`【${role}】`)))
      ?? previous?.currentRole
      ?? (mine.length && mine.every(({ type }) => type === 'test') ? '测试' : undefined)
    const labels = ROLES.filter((label) => label !== currentRole)
    const rows = new Map(tasks.map((task) => {
      const id = String(task.id)
      const project = String(task.project)
      taskProjects.set(id, project)
      const button = createLinkButton(new URL(`task-view-${id}.html`, doc.location.href).href, '_blank')
      button.classList.replace('size-sm', 'size-xs')
      button.title = '查看任务详情'
      const cells = labels.map(() => {
        const cell = doc.createElement('span')
        cell.textContent = '—'
        return cell
      })
      return [id, { id, task, project, button, cells }]
    }))

    const columns = cols.filter(({ name }) => !name.startsWith('zentao-')).map((col) => {
      if (col.name === 'name' && Number(col.width) === 0.44 && !col.extraWidth) return { ...col, width: 0.36 }
      // 136px 是禅道文本列的默认宽度。让项目和原型名称使用任务表的剩余空间。
      if (col.name !== 'project' || Number(col.width) !== 136) return col
      return { ...col, width: col.extraWidth ? col.width : 248, flex: 1 }
    })
    const dateColumn = { name: 'zentao-project-end', title: '项目截止', type: 'text', width: 96, sortType: false }
    const projectIndex = columns.findIndex(({ name }) => name === 'project')
    columns.splice(projectIndex >= 0 ? projectIndex + 1 : columns.findIndex(({ name }) => name === 'actions'), 0, dateColumn)
    const roleAnchor = columns.find(({ name }) => name === 'assignedTo')
      ?? columns.find(({ name }) => name === 'project')
      ?? columns.at(-1)
    const anchorIndex = columns.indexOf(roleAnchor)
    // 禅道按 order 排列各列，让角色列共用顺序值，避免中间插入其他列。
    const order = Number(roleAnchor.order ?? anchorIndex) + 0.5
    const roleColumns = labels.map((title) => ({ name: `zentao-${title}`, title, type: 'text', width: title === '测试' ? 88 : 80, sortType: false, order }))
    columns.splice(anchorIndex + 1, 0, ...roleColumns)

    function renderCell(result, info) {
      const content = nativeRenderCell?.call(this, result, info) ?? result
      const row = rows.get(String(info.row.data?.id))
      if (!row) return content
      if (info.col.name === 'name') return [...content, { html: row.button.outerHTML, className: 'zentao-task-link' }]
      if (info.col.name === 'project' && row.prototypeLabel) return [...content, { html: row.prototypeLabel, className: 'zentao-prototype-label' }]
      if (info.col.name === dateColumn.name) return [row.deadline ?? '—']
      const roleIndex = roleColumns.findIndex(({ name }) => name === info.col.name)
      if (roleIndex >= 0) {
        const cell = row.cells[roleIndex]
        return [{ html: cell.innerHTML, attrs: { title: cell.title || undefined } }]
      }
      return content
    }
    let frame
    const refresh = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined
        if (holder.isConnected && table.options.data === data && table.options.onRenderCell === renderCell) table.render()
      })
    }

    addTaskStyles(doc)
    table.render({ cols: columns, bordered: true, onRenderCell: renderCell, footToolbar: addBatchFinishButton(table, pageWindow) })
    const deadlines = getProjectDeadlines()
    deadlines.then((projects) => {
      if (!projects) return
      const dates = new Set()
      for (const row of rows.values()) {
        row.deadline = projects.get(row.project)
        if (row.deadline) dates.add(row.deadline)
      }
      refresh()
      for (const date of dates) syncPrototypeCohort(date).catch(reportCohortError)
    })
    for (const row of rows.values()) {
      if (!Number(row.task.story)) continue
      const apply = (link) => {
        if (link) updateTaskButton(row, link)
        else {
          row.button.href = new URL(`task-view-${row.id}.html`, doc.location.href).href
          row.button.target = '_blank'
          row.button.textContent = '查看'
          row.button.title = '查看任务详情'
          row.prototypeLabel = undefined
        }
        refresh()
      }
      deadlines.then(() => {
        const cached = GM_getValue(storyLinkKey(row.task))
        if (cached) apply(cached.link)
      })
      Promise.all([loadStoryLink(row.task), deadlines]).then(([link]) => apply(link)).catch((error) => {
        if (row.button.title === '查看任务详情') row.button.title = '需求链接读取失败，点击查看任务详情'
        refresh()
        console.error('读取需求链接失败', error)
      })
    }
    addTaskAssignees([...rows.values()], labels, deadlines, refresh)
    return { table, data, currentRole, nativeRenderCell, renderCell }
  }

  function addBatchFinishButton(table, pageWindow) {
    const toolbar = table.options.footToolbar
    if (!toolbar) return toolbar
    const items = toolbar.items.filter(({ key }) => key !== 'zentao-batch-finish')
    const closeIndex = items.findIndex((item) => item['data-url']?.includes('/task-batchClose'))
    const button = {
      key: 'zentao-batch-finish',
      text: '批量完成',
      disabled: batchFinishing,
      onClick: () => finishSelectedTasks(table, pageWindow, button),
    }
    items.splice(closeIndex < 0 ? items.length : closeIndex + 1, 0, button)
    return { ...toolbar, items }
  }

  async function finishSelectedTasks(table, pageWindow, button) {
    if (batchFinishing) return
    const notify = (type, content) => pageWindow.zui.Messager.show({ type, content })
    const selected = table.$.getChecks().map((id) => table.$.getRowInfo(id)?.data).filter(Boolean)
    if (!selected.length) {
      notify('warning', '请先勾选任务')
      return
    }
    const eligible = selected.filter((task) => task.actions.some(({ name, disabled }) => name === 'finish' && !disabled))
    if (!eligible.length) {
      notify('warning', '所选任务中没有可执行「完成」的任务')
      return
    }

    const listUrl = pageWindow.location.href
    const account = pageWindow.config.account
    let skipped = selected.length - eligible.length
    let succeeded = 0
    const failed = []
    batchFinishing = true
    button.disabled = true
    button.text = '完成中…'
    try {
      table.render()
      for (const { id } of eligible) {
        try {
          if (await finishTask(id, listUrl, account)) succeeded++
          else skipped++
        } catch (error) {
          failed.push(id)
          console.error(`禅道任务 #${id} 需核对状态、指派人和工时`, error)
        }
      }
    } finally {
      batchFinishing = false
      if (table.element.isConnected) {
        // 处理期间分页或排序可能重新生成工具栏。
        const currentButton = table.options.footToolbar.items.find(({ key }) => key === button.key)
        if (currentButton) {
          currentButton.disabled = false
          currentButton.text = '批量完成'
          table.render()
        }
      }
    }

    const summary = [`完成操作成功 ${succeeded} 项`]
    if (skipped) summary.push(`跳过 ${skipped} 项`)
    if (failed.length) summary.push(`需核对 ${failed.length} 项（${failed.map((id) => `#${id}`).join('、')}）`)
    notify(failed.length || !succeeded ? 'warning' : 'success', summary.join('，'))
    if ((succeeded || failed.length) && pageWindow.location.href === listUrl) pageWindow.loadPage({ url: listUrl, cache: false })
  }

  async function finishTask(id, baseUrl, account) {
    const viewUrl = new URL(`task-view-${id}.json`, baseUrl)
    const { task } = await fetchZenTao(viewUrl)
    if (!UNFINISHED.includes(task.status) || task.isParent) return false
    const member = Object.values(task.team ?? {}).find((member) => member.account === account)
    if (member?.status === 'done' || (!member && task.assignedTo !== account)) return false

    const url = new URL(`task-finish-${id}.html`, baseUrl)
    const request = async (target, options) => {
      const response = await fetch(target, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        ...options,
      })
      if (!response.ok) throw new Error(`禅道返回 HTTP ${response.status}`)
      return response
    }
    const readForm = async (target, selector) => {
      const response = await request(target)
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html')
      return doc.querySelector(selector)
    }
    const form = await readForm(url, '#finishForm form')
    if (!form) throw new Error('禅道未提供完成表单')

    const body = new FormData(form)
    // 未挂载的 ZUI 日期选择器还没有生成对应表单字段，读取原生控件的默认值。
    const dateValue = (name) => {
      const attribute = 'zui-create-datetimepicker'
      const options = form.querySelector(`[data-name="${name}"] [${attribute}]`)?.getAttribute(attribute)
      return options ? JSON.parse(options).defaultValue : body.get(name)
    }
    const finishedDate = dateValue('finishedDate')
    if (!finishedDate) throw new Error('禅道未提供默认完成时间')
    body.set('finishedDate', finishedDate)
    body.set('realStarted', dateValue('realStarted') || finishedDate)
    body.set('assignedTo', account)
    body.set('currentConsumed', String(Math.floor(Math.random() * 5) + 2))

    const result = await (await request(url, { method: 'POST', body })).json()
    if (result.result !== 'success') throw new Error('禅道未确认完成', { cause: result.message })
    if (member) {
      // 多人任务整体完成时，禅道会把指派人改回创建人。
      try {
        const { task: finished } = await fetchZenTao(viewUrl)
        if (finished.status === 'done' && finished.assignedTo !== account) {
          const assignUrl = new URL(`task-assignTo-${finished.execution}-${id}.html`, baseUrl)
          const assignForm = await readForm(assignUrl, 'form:has([data-name="assignedTo"])')
          if (!assignForm) throw new Error('禅道未提供指派表单')
          const assignment = new FormData(assignForm)
          assignment.set('assignedTo', account)
          const saved = await (await request(assignUrl, { method: 'POST', body: assignment })).json()
          if (saved.result !== 'success') throw new Error('禅道未确认指派', { cause: saved.message })
        }
      } catch (error) {
        throw new Error('完成操作已保存，请核对指派人', { cause: error })
      }
    }
    return true
  }

  function addTaskStyles(doc) {
    if (doc.getElementById('zentao-task-styles')) return
    const style = doc.createElement('style')
    style.id = 'zentao-task-styles'
    style.textContent = `
      .zentao-task-link {
        display: flex;
        flex: none;
        margin-inline-start: auto;
      }
      #table-my-work [data-col="name"] .dtable-cell-content > a.overflow-hidden {
        text-overflow: ellipsis;
      }
      .zentao-prototype-label {
        min-inline-size: 0;
        margin-inline-start: 6px;
      }
      .zentao-prototype-label > .label {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .zentao-assignee {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .zentao-assignee-status {
        flex: 0 0 7px;
        inline-size: 7px;
        block-size: 7px;
        border-radius: 50%;
        background: #adb5bd;
      }
      .zentao-assignee-status:is([data-status="wait"], [data-status="doing"], [data-status="pause"]) {
        background: #c58b16;
      }
      .zentao-assignee-status[data-status="done"] { background: #38b03f; }
    `
    doc.head.append(style)
  }

  async function addTaskAssignees(rows, labels, projectDeadlines, refresh) {
    const deadlines = await projectDeadlines
    if (!deadlines) {
      for (const { cells } of rows) {
        for (const cell of cells) cell.textContent = '读取失败'
      }
      refresh()
      return
    }
    const today = new Date().setHours(0, 0, 0, 0)
    const upcomingRows = rows.filter(({ project, task }) => {
      const deadline = deadlines.get(project)
      return Number(task.story) > 0 && deadline && new Date(`${deadline}T00:00:00`).getTime() >= today
    })
    // 缓存只用于先显示结果，每次刷新仍重新读取关联任务状态。
    for (const row of upcomingRows) {
      row.cacheKey = `storyAssignees:22.7/${row.project}/${row.task.story}/${labels.join('/')}`
      const cached = GM_getValue(row.cacheKey)
      if (cached?.people && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000 && (!cached.completedOnly || row.task.status === 'done')) {
        row.hasCachedAssignees = true
        renderTaskAssignees(row.cells, cached.people)
      } else {
        for (const cell of row.cells) cell.textContent = '…'
      }
    }

    refresh()
    const groups = Object.groupBy(upcomingRows, ({ project, task }) => `${project}/${task.story}`)
    await Promise.all(Object.values(groups).map(async (rows) => {
      const { project, task: { story } } = rows[0]
      let related
      try {
        related = await readRelatedTasks(project, story, rows, labels)
      } catch (error) {
        for (const { cells, hasCachedAssignees } of rows) {
          for (const cell of cells) {
            if (!hasCachedAssignees) cell.textContent = '读取失败'
            cell.title = error.message
          }
        }
        console.error(`读取需求 #${story} 的关联任务失败`, error)
        refresh()
        return
      }

      const { results, users } = related
      const assignees = results.map((result, index) => {
        if (result.status === 'rejected') {
          console.error(`读取需求 #${story} 的${labels[index]}任务失败`, result.reason)
          return null
        }
        return result.value.map((task) => {
          const account = task.finishedBy || task.assignedTo
          // 完成后被关闭的任务仍按已完成显示。
          const status = task.status === 'closed' && task.closedReason === 'done' ? 'done' : task.status
          return { name: account ? users[account] || account : null, id: task.id, status }
        })
      })
      const rank = (status) => (UNFINISHED.includes(status) ? 2 : Number(status === 'done'))
      // 同一人有多个任务时，圆点显示最需要关注的状态。
      const people = assignees.map((group) => group && Array.from(Map.groupBy(group, ({ name }) => name), ([name, tasks]) => ({
        name,
        status: tasks.reduce((a, b) => (rank(b.status) > rank(a.status) ? b : a)).status,
        ids: tasks.map(({ id }) => id),
      })))
      for (const { cells, hasCachedAssignees } of rows) {
        renderTaskAssignees(cells, people, hasCachedAssignees)
        results.forEach((result, index) => {
          if (result.status === 'rejected') cells[index].title = result.reason.cause?.message ?? result.reason.message
        })
      }
      // 只缓存完整的读取结果。
      if (!assignees.includes(null)) {
        const complete = assignees.every((group) => group.length && group.every(({ name }) => name))
        const testers = assignees[labels.indexOf('测试')]
        const settled = assignees.flat().every(({ status }) => !UNFINISHED.includes(status))
        for (const { task, cacheKey } of rows) {
          const completedWithTest = task.status === 'done' && testers?.length && testers.every(({ name }) => name)
          if (settled && (complete || completedWithTest)) {
            GM_setValue(cacheKey, { people, savedAt: Date.now(), completedOnly: !complete })
          } else {
            GM_deleteValue(cacheKey)
          }
        }
      }
      refresh()
    }))
  }

  function renderTaskAssignees(cells, people, keepCached) {
    const statusLabels = { wait: '未开始', doing: '进行中', pause: '已暂停', done: '已完成', closed: '已关闭', cancel: '已取消' }
    cells.forEach((cell, index) => {
      if (people[index] === null) {
        if (!keepCached) cell.textContent = '读取失败'
        return
      }
      cell.replaceChildren()
      if (!people[index].length) cell.append('—')
      people[index].forEach(({ name, status, ids }, order) => {
        if (order) cell.append('、')
        if (!name) {
          cell.append('未指派')
          return
        }
        const person = document.createElement('span')
        person.className = 'zentao-assignee'
        person.textContent = name
        const dot = document.createElement('span')
        dot.className = 'zentao-assignee-status'
        dot.dataset.status = status
        dot.title = `任务 ${ids.map((id) => `#${id}`).join('、')}：${statusLabels[status] || status}`
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', `${name}，${dot.title}`)
        person.prepend(dot)
        cell.append(person)
      })
    })
  }

  function getTaskRole(task) {
    const taggedRole = task.name.match(/【(前端|后端|测试)】/)?.[1]
    if (taggedRole) return taggedRole
    if (task.type === 'test') return '测试'
    if (task.type === 'devel') return '后端'
  }

  async function readRelatedTasks(project, story, rows, labels) {
    // 项目任务列表即使返回 JSON，也会覆盖禅道批量编辑使用的返回地址。
    const data = await fetchZenTao(new URL(`story-view-${story}.json`, location.href))
    // 新版需求详情按执行分组，一个项目下可能有多个执行。
    const tasks = Object.values(data.story.tasks ?? {})
      .flatMap(flattenTasks)
      .filter((task) => String(task.project) === project && task.status !== 'cancel')
      .sort((a, b) => Number(a.id) - Number(b.id))
    const tasksById = new Map(rows.map(({ id, task }) => [id, task]))
    const byRole = Object.groupBy(tasks, (task) => getTaskRole(tasksById.get(String(task.id)) ?? task))
    const readTask = async (summary) => {
      const current = tasksById.get(String(summary.id))
      if (current) return current
      // 需求详情里的任务缺少 finishedBy。未完成的任务用当前指派人即可。
      if (UNFINISHED.includes(summary.status)) return summary
      try {
        const { task } = await fetchZenTao(new URL(`task-view-${summary.id}.json`, location.href))
        return task
      } catch (error) {
        throw new Error(`读取关联任务 #${summary.id} 失败`, { cause: error })
      }
    }
    const results = await Promise.allSettled(labels.map((label) => Promise.all((byRole[label] ?? []).map(readTask))))
    return { results, users: data.users ?? {} }
  }

  function createPrototypeLabel(folder) {
    const segments = folder.split('/').filter(Boolean).slice(-2)
    if (!segments.length) return

    let name = segments.join(' · ')
    try {
      name = segments.map(decodeURIComponent).join(' · ')
    } catch {
      // 需求地址包含无法解码的路径时，显示原路径名称。
    }
    const label = document.createElement('span')
    label.className = 'label gray-pale'
    label.textContent = name
    label.title = name
    return label.outerHTML
  }

  function storyLinkKey(task) {
    return `storyLink:${task.story}/${task.storyVersion}/${task.latestStoryVersion}`
  }

  function loadStoryLink(task) {
    const key = storyLinkKey(task)
    const cached = GM_getValue(key)
    if (cached && Date.now() - cached.savedAt <= 7 * 24 * 60 * 60 * 1000) return Promise.resolve(cached.link)
    let request = storyLinkRequests.get(key)
    if (!request) {
      const href = new URL(`task-view-${task.id}.json`, location.href)
      request = fetchZenTao(href).then(({ task }) => {
        const doc = new DOMParser().parseFromString(task.storySpec ?? '', 'text/html')
        const link = parseRequirementLink(doc, href) ?? null
        GM_setValue(key, { link, savedAt: Date.now() })
        return link
      }).finally(() => storyLinkRequests.delete(key))
      storyLinkRequests.set(key, request)
    }
    return request
  }

  function updateTaskButton(row, link) {
    const { button, deadline } = row
    const prototype = prototypePageReference(new URL(link.url))
    button.href = prototype && deadline ? linkWithDeadline(link.url, deadline, prototype.part) : link.url
    button.target = link.target || '_blank'
    button.textContent = prototype ? '查看' : '查看需求'
    button.removeAttribute('title')
    row.prototypeLabel = prototype && createPrototypeLabel(prototype.folder)
  }

  function syncPrototypeCohort(deadline) {
    let request = cohortRequests.get(deadline)
    if (!request) {
      request = savePrototypeCohort(deadline).finally(() => cohortRequests.delete(deadline))
      cohortRequests.set(deadline, request)
    }
    return request
  }

  async function savePrototypeCohort(deadline) {
    const deadlines = await getProjectDeadlines()
    if (!deadlines) return
    const tasks = await readAssignedTasks()
    const relevant = tasks.filter((task) => Number(task.story) > 0 && deadlines.get(String(task.project)) === deadline)
    const pages = {}
    await Promise.all(relevant.map(async (task) => {
      const link = await loadStoryLink(task)
      const prototype = link && prototypePageReference(new URL(link.url))
      if (!prototype) return
      const { key, path } = prototype
      const state = UNFINISHED.includes(task.status) ? 2 : Number(task.status === 'done')
      pages[key] = { path, state: Math.max(pages[key]?.state ?? 0, state) }
    }))
    // 整个截止日期的任务都读取成功后才覆盖之前的目录状态。
    const key = PROTOTYPE_COHORT_KEY + deadline
    GM_setValue(key, pages)
    pruneStoredValues(new Set([key, ...relevant.map(storyLinkKey)]))
  }

  function reportCohortError(error) {
    console.error('加载同截止日期的禅道任务失败', error)
  }

  function pruneStoredValues(keepKeys) {
    const expiredAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    for (const key of GM_listValues()) {
      if (keepKeys.has(key)) continue
      const date = key.match(/^prototypeTask(?:Pages|Cohort):(\d{4}-\d{2}-\d{2})$/)?.[1]
      const savedAt = date ? Date.parse(`${date}T00:00:00`) : key.startsWith('storyLink:') || key.startsWith('storyAssignees:') ? GM_getValue(key).savedAt : undefined
      if (savedAt < expiredAt) GM_deleteValue(key)
    }
  }

  async function readAssignedTasks() {
    const path = 'my-work-task-assignedTo-0-id_desc'
    const first = await fetchZenTao(new URL(`${path}-0-2000-1.json`, location.href))
    const { recTotal, recPerPage, pageTotal } = first.pager
    const tasks = flattenTasks(first.tasks)
    for (let page = 2; page <= Number(pageTotal); page++) {
      const href = new URL(`${path}-${recTotal}-${recPerPage}-${page}.json`, location.href)
      tasks.push(...flattenTasks((await fetchZenTao(href)).tasks))
    }
    if (new Set(tasks.map((task) => task.id)).size !== Number(recTotal)) throw new Error('分页中的任务数与列表总数不符')
    return tasks
  }

  function flattenTasks(tasks) {
    return Object.values(tasks).flatMap((task) => [task, ...flattenTasks(task.children ?? {})])
  }

  function requestZenTao(href) {
    // 只合并进行中的相同请求，完成后移除，后续调用仍拿到最新数据。
    const key = href.href
    let request = pendingZenTaoRequests.get(key)
    if (!request) {
      request = sendZenTaoRequest(href).finally(() => pendingZenTaoRequests.delete(key))
      pendingZenTaoRequests.set(key, request)
    }
    return request
  }

  async function sendZenTaoRequest(href) {
    if (activeZenTaoRequests < 6) activeZenTaoRequests++
    else await new Promise((resolve) => zenTaoRequestQueue.push(resolve))
    try {
      const read = () => fetch(href, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) })
      let response = await read()
      // 同一批请求可能偶尔收到登录重定向。只重读一次，避免跟随跳转或重复写入。
      if (response.type === 'opaqueredirect') {
        await new Promise((resolve) => setTimeout(resolve, 500))
        response = await read()
        if (response.type === 'opaqueredirect') throw new Error('禅道接口被重定向，请检查登录状态或访问权限')
      }
      if (!response.ok) throw new Error(`禅道返回 HTTP ${response.status}`)
      return await response.text()
    } finally {
      // 排队请求直接接手当前槽位，避免被新请求抢占。
      const next = zenTaoRequestQueue.shift()
      if (next) next()
      else activeZenTaoRequests--
    }
  }

  async function fetchZenTao(href) {
    const result = JSON.parse(await requestZenTao(href))
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
      pages = newPages ?? {}
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
