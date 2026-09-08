// ==UserScript==
// @name         Swagger 接口信息复制
// @namespace    https://xt.ty.chaomeifan.com/
// @version      1.2.0
// @description  在 Swagger 接口后添加复制和批量选择功能
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/swagger-copy-interface.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/swagger-copy-interface.user.js
// @match        *://*.chaomeifan.com/api/*/swagger-ui.html*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

;(function () {
  'use strict'

  const BUTTON_CLASS = 'swagger-copy-interface-button'
  const ACTIONS_CLASS = 'swagger-copy-interface-actions'
  const CHECKBOX_CLASS = 'swagger-copy-interface-checkbox'
  const GROUP_CHECKBOX_CLASS = 'swagger-copy-group-checkbox'
  const SELECTION_BAR_CLASS = 'swagger-copy-selection-bar'
  const MAX_SCHEMA_DEPTH = 8
  const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch']
  const specCache = new Map()
  const BUTTON_ICONS = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>',
    url: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15"></path></svg>',
    loading: '<svg class="is-spinning" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"></path></svg>',
    success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6m0-6-6 6"></path></svg>',
  }
  let scanScheduled = false
  let activeSpecUrl = ''
  const selectedOperations = new Set()

  GM_addStyle(`
    .${BUTTON_CLASS} {
      flex: 0 0 auto;
      margin: 0 !important;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 26px;
      height: 26px;
      padding: 6px;
      border: 1px solid currentColor;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.82);
      color: #3b4151;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
    }

    .${ACTIONS_CLASS} {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 10px;
    }

    .${CHECKBOX_CLASS} {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: #4990e2;
      cursor: pointer;
    }

    .${GROUP_CHECKBOX_CLASS} {
      margin-left: 10px;
    }

    .${SELECTION_BAR_CLASS} {
      position: fixed;
      z-index: 9999;
      bottom: 24px;
      left: 50%;
      display: none;
      align-items: center;
      gap: 12px;
      transform: translateX(-50%);
      padding: 10px 14px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      background: #fff;
      color: #3b4151;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      font-size: 13px;
      white-space: nowrap;
    }

    .${SELECTION_BAR_CLASS}.is-visible {
      display: flex;
    }

    .${SELECTION_BAR_CLASS} button {
      padding: 6px 10px;
      border: 1px solid #4990e2;
      border-radius: 4px;
      background: #4990e2;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
    }

    .${SELECTION_BAR_CLASS} button[data-action='clear'] {
      border-color: #999;
      background: #fff;
      color: #555;
    }

    .${SELECTION_BAR_CLASS} button:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    .${BUTTON_CLASS} svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .${BUTTON_CLASS}[data-state='success'] {
      color: #168755;
    }

    .${BUTTON_CLASS}[data-state='error'] {
      color: #d9363e;
    }

    .${BUTTON_CLASS} .is-spinning {
      animation: swagger-copy-spin 0.8s linear infinite;
    }

    @keyframes swagger-copy-spin {
      to { transform: rotate(360deg); }
    }

    .${BUTTON_CLASS}:hover {
      background: #fff;
    }

    .${BUTTON_CLASS}:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    .swagger-copy-interface-toast {
      position: fixed;
      z-index: 10000;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      padding: 9px 14px;
      border-radius: 5px;
      background: #49cc90;
      color: #fff;
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.2);
      font-size: 13px;
    }

    .swagger-copy-interface-toast.is-error {
      background: #f93e3e;
    }
  `)

  function cleanText(value) {
    return String(value || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function refName(ref) {
    return decodeURIComponent(String(ref).split('/').pop())
  }

  function resolveRef(ref, spec) {
    return String(ref)
      .replace(/^#\//, '')
      .split('/')
      .reduce((value, key) => value && value[key], spec)
  }

  function describeType(schema) {
    if (!schema) return '未声明'
    if (schema.$ref) return refName(schema.$ref)
    if (schema.type === 'array') return `array<${describeType(schema.items)}>`
    if (schema.type === 'object' && schema.additionalProperties) {
      return `object<string, ${describeType(schema.additionalProperties)}>`
    }

    const type = schema.type || (schema.properties || schema.allOf ? 'object' : 'any')
    return schema.format ? `${type}(${schema.format})` : type
  }

  function describeRules(schema, required) {
    const rules = []
    if (required) rules.push('必填')
    if (schema.enum) rules.push(`可选值：${schema.enum.join(' / ')}`)
    if (schema.default !== undefined) rules.push(`默认值：${JSON.stringify(schema.default)}`)
    if (schema.minimum !== undefined) rules.push(`最小值：${schema.minimum}`)
    if (schema.maximum !== undefined) rules.push(`最大值：${schema.maximum}`)
    if (schema.minLength !== undefined) rules.push(`最短：${schema.minLength}`)
    if (schema.maxLength !== undefined) rules.push(`最长：${schema.maxLength}`)
    if (schema.pattern) rules.push(`格式：${schema.pattern}`)

    const description = cleanText(schema.description)
    if (description) rules.push(description)
    return rules.length ? `（${rules.join('；')}）` : ''
  }

  function appendSchemaFields(schema, spec, lines, depth, seenRefs, referencedSchemas) {
    if (!schema || depth > MAX_SCHEMA_DEPTH) return

    if (schema.$ref) {
      if (referencedSchemas) {
        referencedSchemas.set(schema.$ref, resolveRef(schema.$ref, spec))
        return
      }

      const name = refName(schema.$ref)
      if (seenRefs.has(name)) return

      const definition = resolveRef(schema.$ref, spec)
      if (!definition) return

      const nextSeenRefs = new Set(seenRefs)
      nextSeenRefs.add(name)
      appendSchemaFields(definition, spec, lines, depth, nextSeenRefs)
      return
    }

    if (schema.type === 'array') {
      appendSchemaFields(schema.items, spec, lines, depth, seenRefs, referencedSchemas)
      return
    }

    if (schema.allOf) {
      schema.allOf.forEach((item) => appendSchemaFields(item, spec, lines, depth, seenRefs, referencedSchemas))
    }

    const requiredFields = new Set(Array.isArray(schema.required) ? schema.required : [])
    Object.entries(schema.properties || {}).forEach(([name, fieldSchema]) => {
      const indentation = '  '.repeat(depth)
      lines.push(`${indentation}- ${name}：${describeType(fieldSchema)}${describeRules(fieldSchema, requiredFields.has(name))}`)
      appendSchemaFields(fieldSchema, spec, lines, depth + 1, seenRefs, referencedSchemas)
    })
  }

  function resolveParameter(parameter, spec) {
    return parameter.$ref ? resolveRef(parameter.$ref, spec) || parameter : parameter
  }

  function resolveResponse(response, spec) {
    return response.$ref ? resolveRef(response.$ref, spec) || response : response
  }

  function buildFullUrl(spec, path) {
    const scheme = (spec.schemes && spec.schemes[0]) || location.protocol.replace(':', '')
    const host = spec.host || location.host
    const basePath = String(spec.basePath || '').replace(/\/$/, '')
    return `${scheme}://${host}${basePath}${path}`
  }

  function formatOperation(spec, path, method, operation, pathItem, options = {}) {
    const lines = []
    const title = cleanText(operation.summary || operation.description) || '未命名接口'
    const { includeGroup = true, referencedSchemas } = options

    lines.push(`接口名称：${title}`)
    if (includeGroup && operation.tags && operation.tags.length) lines.push(`所属分组：${operation.tags.join('、')}`)
    lines.push(`请求方法：${method.toUpperCase()}`)
    lines.push(`接口路径：${path}`)
    lines.push(`完整地址：${buildFullUrl(spec, path)}`)
    const description = cleanText(operation.description)
    if (description && description !== title) lines.push(`说明：${description}`)

    const consumes = operation.consumes || spec.consumes
    if (consumes && consumes.length) lines.push(`请求类型：${consumes.join('、')}`)

    lines.push('', '请求参数：')
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map((item) => resolveParameter(item, spec))

    if (!parameters.length) {
      lines.push('- 无')
    } else {
      parameters.forEach((parameter) => {
        const schema = parameter.schema || parameter
        const descriptionText = cleanText(parameter.description)
        const rules = []
        if (parameter.required) rules.push('必填')
        if (descriptionText && descriptionText !== parameter.name) rules.push(descriptionText)

        lines.push(
          `- ${parameter.name || '未命名参数'} [${parameter.in || 'unknown'}]：${describeType(schema)}${
            rules.length ? `（${rules.join('；')}）` : ''
          }`
        )
        appendSchemaFields(schema, spec, lines, 1, new Set(), referencedSchemas)
      })
    }

    lines.push('', '响应：')
    const responses = Object.entries(operation.responses || {}).filter(([status]) => status === '200')
    if (!responses.length) {
      lines.push('- 未声明')
    } else {
      responses.forEach(([status, originalResponse]) => {
        const response = resolveResponse(originalResponse, spec)
        const responseDescription = cleanText(response.description)
        const schema = response.schema
        lines.push(`- ${status}${responseDescription ? ` ${responseDescription}` : ''}${schema ? `：${describeType(schema)}` : ''}`)
        appendSchemaFields(schema, spec, lines, 1, new Set(), referencedSchemas)
      })
    }

    return lines.join('\n')
  }

  function getGroupName(group) {
    return cleanText(group?.querySelector('a')?.textContent)
  }

  function getGroupOperations(spec, groupName) {
    const operations = []

    Object.entries(spec.paths || {}).forEach(([path, pathItem]) => {
      HTTP_METHODS.forEach((method) => {
        const operation = pathItem[method]
        if (!operation) return

        const tags = operation.tags?.length ? operation.tags : ['default']
        if (tags.includes(groupName)) operations.push({ path, method, operation, pathItem })
      })
    })

    return operations
  }

  function formatSelectedOperations(spec, operations) {
    const referencedSchemas = new Map()
    const lines = [`已选接口：${operations.length} 个`]

    operations.forEach(({ path, method, operation, pathItem }, index) => {
      lines.push('', `===== 接口 ${index + 1} =====`)
      lines.push(formatOperation(spec, path, method, operation, pathItem, { referencedSchemas }))
    })

    const schemaLines = []
    referencedSchemas.forEach((definition, ref) => {
      if (!definition) return

      schemaLines.push('', `${refName(ref)}：${describeType(definition)}`)
      appendSchemaFields(definition, spec, schemaLines, 1, new Set([refName(ref)]), referencedSchemas)
    })

    if (schemaLines.length) lines.push('', '===== 共用数据结构 =====', ...schemaLines)
    return lines.join('\n')
  }

  function operationKey(method, path) {
    try {
      return `${method.toLowerCase()} ${decodeURIComponent(path)}`
    } catch {
      return `${method.toLowerCase()} ${path}`
    }
  }

  function getSelectedOperationDetails(spec) {
    const operations = []

    Object.entries(spec.paths || {}).forEach(([path, pathItem]) => {
      HTTP_METHODS.forEach((method) => {
        const operation = pathItem[method]
        if (operation && selectedOperations.has(operationKey(method, path))) {
          operations.push({ path, method, operation, pathItem })
        }
      })
    })

    return operations
  }

  function getSpecUrl() {
    return document.querySelector('#select')?.value || document.querySelector('.info .url')?.textContent?.trim()
  }

  function getSpec() {
    const url = getSpecUrl()
    if (!url) return Promise.reject(new Error('没有找到当前 Swagger JSON 地址'))
    if (specCache.has(url)) return specCache.get(url)

    const request = fetch(url, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error(`Swagger JSON 加载失败：HTTP ${response.status}`)
        return response.json()
      })
      .catch((error) => {
        specCache.delete(url)
        throw error
      })

    specCache.set(url, request)
    return request
  }

  function showToast(message, isError) {
    document.querySelector('.swagger-copy-interface-toast')?.remove()
    const toast = document.createElement('div')
    toast.className = `swagger-copy-interface-toast${isError ? ' is-error' : ''}`
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 1800)
  }

  function setButtonState(button, state, errorMessage) {
    const labels = {
      copy: '复制接口名称、请求参数和响应字段类型',
      url: '仅复制接口路径',
      loading: '正在读取接口信息',
      success: '已复制',
      error: errorMessage || '复制失败',
    }
    button.dataset.state = state
    button.innerHTML = BUTTON_ICONS[state]
    button.title = labels[state]
    button.setAttribute('aria-label', labels[state])
  }

  function copyOperationUrl(summary, button) {
    const path = summary.querySelector('.opblock-summary-path span')?.textContent?.trim()
    if (!path) return

    try {
      GM_setClipboard(path, 'text')
      setButtonState(button, 'success')
      showToast(`已复制路径：${path}`)
    } catch (error) {
      console.error('[Swagger URL 复制]', error)
      setButtonState(button, 'error', error.message)
      showToast(error.message || 'URL 复制失败', true)
    } finally {
      setTimeout(() => {
        if (button.isConnected) setButtonState(button, 'url')
      }, 1500)
    }
  }

  async function copyOperation(summary, button) {
    const method = summary.querySelector('.opblock-summary-method')?.textContent?.trim().toLowerCase()
    const path = summary.querySelector('.opblock-summary-path span')?.textContent?.trim()
    if (!method || !path) return

    button.disabled = true
    setButtonState(button, 'loading')

    try {
      const spec = await getSpec()
      const normalizedPath = spec.paths?.[path] ? path : decodeURIComponent(path)
      const pathItem = spec.paths?.[normalizedPath]
      const operation = pathItem?.[method]
      if (!operation) throw new Error(`Swagger JSON 中没有找到 ${method.toUpperCase()} ${path}`)

      const text = formatOperation(spec, normalizedPath, method, operation, pathItem)
      GM_setClipboard(text, 'text')
      setButtonState(button, 'success')
      showToast(`已复制：${cleanText(operation.summary) || normalizedPath}`)
    } catch (error) {
      console.error('[Swagger 接口复制]', error)
      setButtonState(button, 'error', error.message)
      showToast(error.message || '复制失败', true)
    } finally {
      setTimeout(() => {
        if (!button.isConnected) return
        button.disabled = false
        setButtonState(button, 'copy')
      }, 1500)
    }
  }

  function ensureSelectionBar() {
    let bar = document.querySelector(`.${SELECTION_BAR_CLASS}`)
    if (bar) return bar

    bar = document.createElement('div')
    bar.className = SELECTION_BAR_CLASS
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', '批量复制接口')

    const count = document.createElement('span')
    count.dataset.role = 'count'
    count.setAttribute('aria-live', 'polite')
    bar.appendChild(count)

    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.dataset.action = 'copy'
    copyButton.textContent = '复制选中接口'
    copyButton.addEventListener('click', () => copySelectedOperations(copyButton))
    bar.appendChild(copyButton)

    const clearButton = document.createElement('button')
    clearButton.type = 'button'
    clearButton.dataset.action = 'clear'
    clearButton.textContent = '清空选中'
    clearButton.addEventListener('click', clearSelectedOperations)
    bar.appendChild(clearButton)

    document.body.appendChild(bar)
    return bar
  }

  async function updateGroupCheckboxes() {
    const specUrl = getSpecUrl()
    const checkboxes = document.querySelectorAll(`.${GROUP_CHECKBOX_CLASS}`)
    if (!specUrl || !checkboxes.length) return

    if (!selectedOperations.size) {
      checkboxes.forEach((checkbox) => {
        checkbox.checked = false
        checkbox.indeterminate = false
      })
      return
    }

    try {
      const spec = await getSpec()
      if (getSpecUrl() !== specUrl) return

      checkboxes.forEach((checkbox) => {
        const groupName = getGroupName(checkbox.closest('.opblock-tag'))
        const operations = getGroupOperations(spec, groupName)
        const selectedCount = operations.filter(({ method, path }) => selectedOperations.has(operationKey(method, path))).length
        checkbox.checked = operations.length > 0 && selectedCount === operations.length
        checkbox.indeterminate = selectedCount > 0 && selectedCount < operations.length
      })
    } catch (error) {
      console.debug('[Swagger 分组选择状态]', error)
    }
  }

  function updateSelectionUi() {
    document.querySelectorAll(`.${CHECKBOX_CLASS}[data-action='select-interface']`).forEach((checkbox) => {
      checkbox.checked = selectedOperations.has(checkbox.dataset.operationKey)
    })

    const bar = ensureSelectionBar()
    const countText = `已选 ${selectedOperations.size} 个接口`
    const count = bar.querySelector('[data-role="count"]')
    if (count.textContent !== countText) count.textContent = countText
    bar.classList.toggle('is-visible', selectedOperations.size > 0)
    updateGroupCheckboxes()
  }

  function clearSelectedOperations() {
    selectedOperations.clear()
    updateSelectionUi()
  }

  function setOperationSelected(method, path, selected) {
    const key = operationKey(method, path)
    if (selected) selectedOperations.add(key)
    else selectedOperations.delete(key)
    updateSelectionUi()
  }

  async function setGroupSelected(group, checkbox) {
    const groupName = getGroupName(group)
    if (!groupName) return

    const shouldSelect = checkbox.checked
    checkbox.disabled = true
    try {
      const spec = await getSpec()
      const operations = getGroupOperations(spec, groupName)
      if (!operations.length) throw new Error(`Swagger JSON 中没有找到分组：${groupName}`)

      operations.forEach(({ method, path }) => {
        const key = operationKey(method, path)
        if (shouldSelect) selectedOperations.add(key)
        else selectedOperations.delete(key)
      })
      updateSelectionUi()
    } catch (error) {
      console.error('[Swagger 分组选择]', error)
      showToast(error.message || '分组选择失败', true)
      checkbox.checked = !shouldSelect
      updateGroupCheckboxes()
    } finally {
      checkbox.disabled = false
    }
  }

  async function copySelectedOperations(button) {
    button.disabled = true
    button.textContent = '复制中…'

    try {
      const spec = await getSpec()
      const operations = getSelectedOperationDetails(spec)
      if (!operations.length) throw new Error('没有找到已选接口')

      GM_setClipboard(formatSelectedOperations(spec, operations), 'text')
      showToast(`已复制 ${operations.length} 个接口`)
    } catch (error) {
      console.error('[Swagger 批量复制]', error)
      showToast(error.message || '批量复制失败', true)
    } finally {
      button.disabled = false
      button.textContent = '复制选中接口'
    }
  }

  function addCopyButtons() {
    const specUrl = getSpecUrl()
    if (specUrl && activeSpecUrl && specUrl !== activeSpecUrl) clearSelectedOperations()
    if (specUrl) activeSpecUrl = specUrl

    document.querySelectorAll('.opblock-tag').forEach((group) => {
      if (group.querySelector(`.${GROUP_CHECKBOX_CLASS}`)) return

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = `${CHECKBOX_CLASS} ${GROUP_CHECKBOX_CLASS}`
      const label = `全选或取消全选分组：${getGroupName(group)}`
      checkbox.title = label
      checkbox.setAttribute('aria-label', label)
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation()
      })
      checkbox.addEventListener('change', () => setGroupSelected(group, checkbox))

      group.insertBefore(checkbox, group.querySelector('.expand-operation'))
    })

    document.querySelectorAll('.opblock-summary').forEach((summary) => {
      const authorizationButton = summary.querySelector('.authorization__btn')
      let actions = summary.querySelector(`.${ACTIONS_CLASS}`)
      if (!actions) {
        actions = document.createElement('span')
        actions.className = ACTIONS_CLASS
        summary.insertBefore(actions, authorizationButton)
      }

      Array.from(summary.children)
        .filter((element) => element.classList.contains(BUTTON_CLASS))
        .forEach((element) => actions.appendChild(element))

      if (!summary.querySelector(`.${BUTTON_CLASS}[data-action='url']`)) {
        const urlButton = document.createElement('button')
        urlButton.type = 'button'
        urlButton.className = BUTTON_CLASS
        urlButton.dataset.action = 'url'
        setButtonState(urlButton, 'url')
        urlButton.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          copyOperationUrl(summary, urlButton)
        })
        actions.appendChild(urlButton)
      }

      if (!summary.querySelector(`.${BUTTON_CLASS}[data-action='interface']`)) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = BUTTON_CLASS
        button.dataset.action = 'interface'
        setButtonState(button, 'copy')
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          copyOperation(summary, button)
        })
        actions.appendChild(button)
      }

      if (!summary.querySelector(`.${CHECKBOX_CLASS}[data-action='select-interface']`)) {
        const method = summary.querySelector('.opblock-summary-method')?.textContent?.trim().toLowerCase()
        const path = summary.querySelector('.opblock-summary-path span')?.textContent?.trim()
        if (!method || !path) return

        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.className = CHECKBOX_CLASS
        checkbox.dataset.action = 'select-interface'
        checkbox.dataset.operationKey = operationKey(method, path)
        checkbox.checked = selectedOperations.has(checkbox.dataset.operationKey)
        const label = `选择接口：${method.toUpperCase()} ${path}`
        checkbox.title = label
        checkbox.setAttribute('aria-label', label)
        checkbox.addEventListener('click', (event) => event.stopPropagation())
        checkbox.addEventListener('change', () => setOperationSelected(method, path, checkbox.checked))
        actions.appendChild(checkbox)
      }
    })

    updateSelectionUi()
  }

  function scheduleButtonScan() {
    if (scanScheduled) return
    scanScheduled = true
    requestAnimationFrame(() => {
      scanScheduled = false
      addCopyButtons()
    })
  }

  new MutationObserver(scheduleButtonScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
  scheduleButtonScan()
})()
