// ==UserScript==
// @name         禅道打开需求链接
// @namespace    http://tampermonkey.net/
// @version      1.9.11
// @description  在禅道任务列表查看需求链接、项目截止日期及同需求的其他角色人员，并在原型目录标记任务状态
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
// https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js?v=1.9.11

;(function () {
  'use strict'

  const PROTOTYPE_HOST = 'redmine.chaomeifan.com'
  const PROTOTYPE_COHORT_KEY = 'prototypeTaskPages:'
  const DEADLINE_PARAM = 'zentaoDeadline'
  const DETAIL_TITLE = '.detail > .detail-title'
  const TASK_LINK = '.c-name a[href*="/task-view-"]'
  const UNFINISHED = ['wait', 'doing', 'pause']
  const pendingZenTaoRequests = new Map()
  const zenTaoRequestQueue = []
  let activeZenTaoRequests = 0

  if (location.hostname === PROTOTYPE_HOST) {
    if (window.top === window) enhancePrototypePages()
    return
  }

  if (document.querySelector('a.btn-active-text[href$="my-task-assignedTo.html"]')) {
    const table = document.querySelector('#tasktable')
    if (!table) return
    const projectDeadlines = readProjectDeadlines()
    addProjectDeadlines(table, projectDeadlines)
    const buttons = addTaskButtons(table)
    layoutTaskTable(table)
    const updateColumnSettings = addTaskTableSettings(table)
    if (!buttons.size) return
    const assignedTasks = readTasks('my-task-assignedTo-id_desc')
    Promise.all([
      addTaskAssignees(table, buttons, projectDeadlines, assignedTasks, updateColumnSettings),
      syncTaskLinks(buttons, projectDeadlines, undefined, assignedTasks),
    ]).catch((error) => {
      const message = document.createElement('p')
      message.textContent = '部分需求信息未同步，请刷新页面重试。'
      message.setAttribute('role', 'status')
      table.before(message)
      console.error('加载禅道需求信息失败', error)
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
    title.style.display = 'flex'
    title.style.alignItems = 'center'
    title.style.columnGap = '8px'
    title.append(button)
    const project = document.querySelector('.breadcrumb a[href*="/project-browse-"]')
    const id = project?.pathname.match(/\/project-browse-(\d+)\.html$/)?.[1]
    const prototype = prototypePageReference(new URL(link.url))
    if (id && prototype) {
      // 截止日期就绪前不可点击，否则原型页拿不到日期参数，打开后也无法再补上。
      button.removeAttribute('href')
      button.classList.add('disabled')
      button.setAttribute('aria-disabled', 'true')
      const projectDeadlines = readProjectDeadlines()
      const deadline = (await projectDeadlines)?.get(id)
      button.href = deadline ? linkWithDeadline(link.url, deadline, prototype.part) : link.url
      button.classList.remove('disabled')
      button.removeAttribute('aria-disabled')
      if (deadline) {
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
    const style = document.createElement('style')
    style.textContent = `
      .zentao-task-settings {
        display: flex;
        justify-content: flex-end;
        margin-block: 8px;
      }
      .zentao-column-settings {
        position: relative;
      }
      .zentao-column-settings > summary {
        list-style: none;
        cursor: pointer;
      }
      .zentao-column-settings > summary::-webkit-details-marker {
        display: none;
      }
      .zentao-column-options {
        position: absolute;
        inset-inline-end: 0;
        inset-block-start: calc(100% + 4px);
        z-index: 1000;
        min-inline-size: 140px;
        max-block-size: min(60vh, 420px);
        overflow-y: auto;
        padding: 8px;
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 4px;
        box-shadow: 0 4px 12px #0002;
      }
      .zentao-column-options label {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 4px 8px;
        white-space: nowrap;
        font-weight: normal;
        cursor: pointer;
      }
      .zentao-column-options input {
        margin: 0;
      }
      #tasktable tbody .c-name > div::before,
      #tasktable .zentao-assignee-status {
        content: '';
        flex: 0 0 7px;
        inline-size: 7px;
        block-size: 7px;
        border-radius: 50%;
      }
      #tasktable .zentao-assignee-status {
        background-color: #adb5bd;
      }
      #tasktable tbody tr[data-zentao-unfinished] .c-name > div::before,
      #tasktable .zentao-assignee-status:is([data-status="wait"], [data-status="doing"], [data-status="pause"]) {
        background-color: #c58b16;
      }
      #tasktable .zentao-assignee-status[data-status="done"] {
        background-color: #38b03f;
      }
      #tasktable .zentao-assignee {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      #tasktable tbody .c-name > div > .label-badge {
        flex-shrink: 0;
      }
    `
    document.head.append(style)
    const widths = {
      id: '88px',
      pri: '40px',
      project: '160px',
      name: 'auto',
      openedBy: '72px',
      assignedTo: '96px',
      finishedBy: '80px',
      estimate: '48px',
      consumed: '48px',
      left: '48px',
      status: '80px',
      截止日期: '100px',
      后端: '88px',
      测试: '88px',
      操作: '176px',
    }
    for (const header of table.tHead.rows[0].cells) {
      const width = widths[getTaskColumnKey(header)]
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

  function getTaskColumnKey(header) {
    return header.querySelector('a[href]')?.getAttribute('href').match(/-([a-z]+)_(?:asc|desc)(?:-|\.html)/i)?.[1] ?? header.textContent.trim()
  }

  function addTaskTableSettings(table) {
    const storageKey = 'taskColumnVisibility:' + (document.querySelector('#userNav .user-name')?.textContent.trim() ?? '')
    const visibility = GM_getValue(storageKey, {})
    const toolbar = document.createElement('div')
    toolbar.className = 'zentao-task-settings'
    const settings = document.createElement('details')
    settings.className = 'zentao-column-settings'
    const summary = document.createElement('summary')
    summary.className = 'btn btn-default btn-sm'
    summary.textContent = '设置'
    const options = document.createElement('div')
    options.className = 'zentao-column-options'
    settings.append(summary, options)
    toolbar.append(settings)
    table.parentElement.before(toolbar)
    const style = document.createElement('style')
    document.head.append(style)

    const update = () => {
      const columns = Array.from(table.tHead.rows[0].cells, (header, index) => ({ key: getTaskColumnKey(header), name: header.textContent.trim(), index: index + 1 }))
      const isVisible = (key) => visibility[key] ?? !['pri', 'estimate', 'left'].includes(key)
      const applyVisibility = () => {
        // 保留单元格，避免影响禅道及人员列插入时使用的列索引；空表提示的跨列单元格保持显示。
        style.textContent = columns.filter(({ key }) => key && !isVisible(key)).map(({ index }) => `
          #tasktable thead tr > :nth-child(${index}),
          #tasktable tbody tr > :nth-child(${index}):not([colspan]) { display: none !important; }
        `).join('')
      }
      options.replaceChildren(...columns.filter(({ key }) => key).map(({ key, name }) => {
        const label = document.createElement('label')
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = isVisible(key)
        checkbox.addEventListener('change', () => {
          visibility[key] = checkbox.checked
          GM_setValue(storageKey, visibility)
          applyVisibility()
        })
        label.append(checkbox, name)
        return label
      }))
      applyVisibility()
    }
    update()
    return update
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
      const id = taskLink.pathname.match(/\/task-view-(\d+)\.html$/)?.[1]
      if (!id) continue
      const cell = taskLink.closest('.c-name')
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
      row.append(...cell.childNodes, button)
      cell.append(row)
      buttons.set(id, button)
    }
    return buttons
  }

  async function addTaskAssignees(table, buttons, projectDeadlines, assignedTasks, updateColumnSettings) {
    const assignedHeader = table.querySelector('thead a[href*="-assignedTo_"]')?.closest('th')
    if (!assignedHeader) return

    const layoutKey = 'assigneeColumns:' + (document.querySelector('#userNav .user-name')?.textContent.trim() ?? '')
    const headers = []
    const rows = Array.from(buttons, ([id, button]) => {
      const element = button.closest('tr')
      const project = element.querySelector('.c-project a')?.pathname.match(/\/project-browse-(\d+)\.html$/)?.[1]
      return { id, element, project, assignedCell: element.cells[assignedHeader.cellIndex], cells: [] }
    })
    const setColumns = (labels) => {
      for (const header of headers.splice(labels.length)) header.remove()
      for (const { cells } of rows) {
        for (const cell of cells.splice(labels.length)) cell.remove()
      }
      labels.forEach((label, index) => {
        if (!headers[index]) {
          const header = document.createElement('th')
          header.scope = 'col'
          header.style.width = '88px'
          ;(headers[index - 1] ?? assignedHeader).after(header)
          headers.push(header)
          for (const { assignedCell, cells } of rows) {
            const cell = document.createElement('td')
            cell.textContent = '—'
            cell.style.whiteSpace = 'normal'
            cell.style.overflowWrap = 'anywhere'
            ;(cells[index - 1] ?? assignedCell).after(cell)
            cells.push(cell)
          }
        }
        headers[index].textContent = label
      })
      updateColumnSettings()
    }
    // 沿用当前用户上次的列布局，首次使用先预留两列，避免等待接口时挤动表格。
    setColumns(GM_getValue(layoutKey, ['', '']))

    const [{ tasks: assigned }, deadlines] = await Promise.all([assignedTasks, projectDeadlines])
    const visibleTasks = assigned.filter((task) => buttons.has(String(task.id)))
    const assignedById = new Map(visibleTasks.map((task) => [String(task.id), task]))
    for (const row of rows) {
      row.task = assignedById.get(row.id)
      row.element.toggleAttribute('data-zentao-unfinished', UNFINISHED.includes(row.task?.status))
    }
    const organizationRoles = await readOrganizationRoles()
    // 「指派给我」接口返回的任务均指派给当前登录人。
    const currentRole = organizationRoles.get(assigned[0]?.assignedTo)
    const roles = ['前端', '后端', '测试'].filter((label) => label !== currentRole).map((label) => ({
      label,
      matches: (task) => getTaskRole(task, organizationRoles) === label,
    }))
    const labels = roles.map(({ label }) => label)
    setColumns(labels)
    GM_setValue(layoutKey, labels)

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
    // 缓存只用于先显示结果，每次刷新仍重新读取关联任务状态。
    for (const row of upcomingRows) {
      row.cacheKey = Number(row.task?.story) > 0 ? `storyAssignees:${row.project}/${row.task.story}/${labels.join('/')}` : null
      const cached = row.cacheKey ? GM_getValue(row.cacheKey) : null
      if (cached?.people && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000 && (!cached.completedOnly || row.task.status === 'done')) {
        renderTaskAssignees(row.cells, cached.people)
      } else {
        for (const cell of row.cells) cell.textContent = '…'
      }
    }

    await Promise.all(
      Object.entries(Object.groupBy(upcomingRows, (row) => row.project)).map(async ([project, rows]) => {
        try {
          const { tasks, users } = await readRelatedTasks(project, rows, assigned)
          const tasksByStory = Object.groupBy(
            tasks.filter((task) => Number(task.story) > 0),
            (task) => task.story
          )
          for (const { task, cells, cacheKey } of rows) {
            const related = tasksByStory[task?.story] ?? []
            const assignees = roles.map(({ matches }) => related.filter(matches).map((task) => {
              const account = task.finishedBy || task.assignedTo
              // 完成后被关闭的任务仍按已完成显示，只有取消关闭的才显示为已关闭。
              const status = task.status === 'closed' && task.closedReason === 'done' ? 'done' : task.status
              return { name: account ? users[account] || account : null, id: task.id, status }
            }))
            const rank = (status) => (UNFINISHED.includes(status) ? 2 : Number(status === 'done'))
            // 同一人有多个任务时，圆点显示最需要关注的状态。
            const people = assignees.map((group) => Array.from(Map.groupBy(group, ({ name }) => name), ([name, tasks]) => ({
              name,
              status: tasks.reduce((a, b) => (rank(b.status) > rank(a.status) ? b : a)).status,
              ids: tasks.map(({ id }) => id),
            })))
            renderTaskAssignees(cells, people)
            const complete = assignees.every((group) => group.length && group.every(({ name }) => name))
            const testers = assignees[labels.indexOf('测试')]
            const completedWithTest = task?.status === 'done' && testers?.length && testers.every(({ name }) => name)
            const settled = assignees.flat().every(({ status }) => !UNFINISHED.includes(status))
            // 已完成且已找到测试的任务也可缓存，缺人的结果只供已完成任务复用。
            // 还有未完成的任务时状态随时会变，不缓存。
            if (cacheKey && settled && (complete || completedWithTest)) {
              GM_setValue(cacheKey, { people, savedAt: Date.now(), completedOnly: !complete })
            } else if (cacheKey) {
              GM_deleteValue(cacheKey)
            }
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

  function renderTaskAssignees(cells, people) {
    const statusLabels = { wait: '未开始', doing: '进行中', pause: '已暂停', done: '已完成', closed: '已关闭', cancel: '已取消' }
    cells.forEach((cell, index) => {
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

  async function readOrganizationRoles() {
    const cached = GM_getValue('organizationRoles')
    if (cached && Date.now() - cached.savedAt < 7 * 24 * 60 * 60 * 1000) return new Map(cached.roles)
    const groups = [
      { role: '前端', departments: [13, 14] }, // 前端组、APP组
      { role: '后端', departments: [8, 9, 10, 11, 12] }, // 开发一至五组
      { role: '测试', departments: [2] },
    ]
    const members = await Promise.all(groups.flatMap(({ role, departments }) => departments.map(async (id) => {
      const html = await requestZenTao(new URL(`dept-ajaxGetUsers-${id}.html`, location.href))
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const select = doc.querySelector('select[name="user"]')
      if (!select) throw new Error('组织分组读取失败，请确认登录状态和组织权限')
      return Array.from(select.options).filter((option) => option.value).map((option) => [option.value, role])
    })))
    const roles = members.flat()
    GM_setValue('organizationRoles', { roles, savedAt: Date.now() })
    return new Map(roles)
  }

  function getTaskRole(task, organizationRoles) {
    const account = task.finishedBy || task.assignedTo
    if (account) return organizationRoles.get(account)
    if (task.type === 'test') return '测试'
    if (task.type === 'devel') return task.name.includes('【前端】') ? '前端' : '后端'
  }

  async function readRelatedTasks(project, rows, assigned) {
    const stories = [...new Set(rows.map(({ task }) => task?.story).filter((story) => Number(story) > 0))]
    const tasksById = new Map(assigned.map((task) => [String(task.id), task]))
    const relatedIds = new Set()
    const users = {}
    let next = 0
    const readStories = async () => {
      while (next < stories.length) {
        // 项目任务列表即使返回 JSON，也会覆盖禅道批量编辑使用的返回地址。
        const story = stories[next++]
        const data = await fetchZenTao(new URL(`story-view-${story}.json`, location.href))
        Object.assign(users, data.users)
        const storyTasks = flattenTasks(data.story.tasks[project] ?? {}).sort((a, b) => Number(a.id) - Number(b.id))
        for (const storyTask of storyTasks) {
          if (storyTask.status === 'cancel') continue
          const id = String(storyTask.id)
          relatedIds.add(id)
          if (tasksById.has(id)) continue
          // 需求详情里的任务缺少 finishedBy 和 type，只有已指派的未完成任务不需要再查详情。
          if (storyTask.assignedTo && UNFINISHED.includes(storyTask.status)) {
            tasksById.set(id, { ...storyTask, story })
            continue
          }
          const { task } = await fetchZenTao(new URL(`task-view-${id}.json`, location.href))
          for (const loaded of flattenTasks([task])) tasksById.set(String(loaded.id), loaded)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, stories.length) }, readStories))
    return { tasks: [...relatedIds].map((id) => tasksById.get(id)), users }
  }

  function setPrototypeLabel(button, folder) {
    if (button.previousElementSibling?.matches('[data-prototype-label]')) button.previousElementSibling.remove()
    button.style.marginInlineStart = 'auto'
    if (!folder) return
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

  async function syncTaskLinks(buttons, projectDeadlines, selectedDate, assignedTasks = readTasks('my-task-assignedTo-id_desc')) {
    const [{ tasks }, deadlines] = await Promise.all([assignedTasks, projectDeadlines])
    const visibleDates = tasks
      .filter((task) => buttons.has(String(task.id)))
      .map((task) => deadlines?.get(String(task.project)))
      .filter(Boolean)
    const dates = new Set(selectedDate ? [selectedDate] : visibleDates)
    const relevantTasks = tasks.filter((task) => Number(task.story) > 0 && (buttons.has(String(task.id)) || dates.has(deadlines?.get(String(task.project)))))
    const groups = Object.groupBy(relevantTasks, (task) => `${task.story}/${task.storyVersion}/${task.latestStoryVersion}`)
    const jobs = Object.entries(groups)
      .map(([version, tasks]) => ({
        version,
        tasks,
        visible: tasks.some((task) => buttons.has(String(task.id))),
      }))
      .sort((a, b) => Number(b.visible) - Number(a.visible))

    const applyLink = (tasks, link) => {
      const prototype = link && prototypePageReference(new URL(link.url))
      for (const task of tasks) {
        const end = deadlines?.get(String(task.project))
        const button = buttons.get(String(task.id))
        if (!button) continue
        button.href = link?.url ?? new URL(`task-view-${task.id}.html`, location.href).href
        if (prototype && end) button.href = linkWithDeadline(link.url, end, prototype.part)
        button.target = link?.target || '_blank'
        if (link) button.removeAttribute('title')
        else button.title = '查看任务详情'
        setPrototypeLabel(button, prototype?.folder)
      }
    }
    const publish = () => {
      const cohorts = new Map([...dates].map((date) => [date, {}]))
      for (const { tasks, link } of jobs) {
        const prototype = link && prototypePageReference(new URL(link.url))
        for (const task of tasks) {
          const end = deadlines?.get(String(task.project))
          // 未收齐链接的日期保留上次完整快照，避免请求失败清空已有标记。
          if (link === undefined) {
            cohorts.delete(end)
            continue
          }
          const pages = cohorts.get(end)
          if (!prototype || !pages) continue

          // 每次从需求的最新结果重算，移除旧链接后仍保留其他任务的标记。
          const { key, path } = prototype
          const state = UNFINISHED.includes(task.status) ? 2 : Number(task.status === 'done')
          pages[key] = { path, state: Math.max(pages[key]?.state ?? 0, state) }
        }
      }
      for (const [date, pages] of cohorts) GM_setValue(PROTOTYPE_COHORT_KEY + date, pages)
    }

    // 过期的缓存先用于显示，避免刷新期间或请求失败时清空原型页的标记。
    const pending = jobs.filter((job) => {
      const cached = GM_getValue(`storyLink:${job.version}`)
      job.link = cached?.link
      if (cached) applyLink(job.tasks, job.link)
      return !cached || Date.now() - cached.savedAt > 7 * 24 * 60 * 60 * 1000
    })
    publish()
    pruneStoredValues(new Set([...jobs.map(({ version }) => `storyLink:${version}`), ...[...dates].map((date) => PROTOTYPE_COHORT_KEY + date)]))

    const concurrency = 6
    let next = 0
    let completed = 0
    let failed = false
    const syncPendingLinks = async () => {
      while (next < pending.length) {
        const job = pending[next++]
        const { version, tasks } = job
        try {
          const href = new URL(`task-view-${tasks[0].id}.json`, location.href)
          const { task } = await fetchZenTao(href)
          const doc = new DOMParser().parseFromString(task.storySpec ?? '', 'text/html')
          job.link = parseRequirementLink(doc, href) ?? null
          GM_setValue(`storyLink:${version}`, { link: job.link, savedAt: Date.now() })
          applyLink(tasks, job.link)
        } catch {
          failed = true
        }
        completed++
        // 每完成一批就同步，已打开的原型页可以逐步更新。
        if (completed % 24 === 0 || completed === pending.length) publish()
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
      const savedAt = date ? Date.parse(`${date}T00:00:00`) : key.startsWith('storyLink:') || key.startsWith('storyAssignees:') ? GM_getValue(key).savedAt : undefined
      if (savedAt < expiredAt) GM_deleteValue(key)
    }
  }

  async function readTasks(path) {
    const first = await fetchZenTao(new URL(`${path}-0-2000-1.json`, location.href))
    const { recTotal, recPerPage, pageTotal } = first.pager
    const tasks = flattenTasks(first.tasks)
    for (let page = 2; page <= Number(pageTotal); page++) {
      const href = new URL(`${path}-${recTotal}-${recPerPage}-${page}.json`, location.href)
      tasks.push(...flattenTasks((await fetchZenTao(href)).tasks))
    }
    if (new Set(tasks.map((task) => task.id)).size !== Number(recTotal)) throw new Error('分页中的任务数与列表总数不符')
    return { tasks, users: first.users }
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
      const response = await fetch(href, { redirect: 'error', signal: AbortSignal.timeout(15000) })
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
