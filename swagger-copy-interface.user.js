// ==UserScript==
// @name         Swagger 接口信息复制
// @namespace    https://xt.ty.chaomeifan.com/
// @version      1.0.10
// @description  在 Swagger 每个接口后添加按钮，复制接口名称、请求参数和响应字段类型
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
  const MAX_SCHEMA_DEPTH = 8
  const specCache = new Map()
  const BUTTON_ICONS = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>',
    url: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15"></path></svg>',
    loading: '<svg class="is-spinning" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"></path></svg>',
    success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6m0-6-6 6"></path></svg>',
  }
  let scanScheduled = false

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

  function appendSchemaFields(schema, spec, lines, depth, seenRefs) {
    if (!schema || depth > MAX_SCHEMA_DEPTH) return

    if (schema.$ref) {
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
      appendSchemaFields(schema.items, spec, lines, depth, seenRefs)
      return
    }

    if (schema.allOf) {
      schema.allOf.forEach((item) => appendSchemaFields(item, spec, lines, depth, seenRefs))
    }

    const requiredFields = new Set(Array.isArray(schema.required) ? schema.required : [])
    Object.entries(schema.properties || {}).forEach(([name, fieldSchema]) => {
      const indentation = '  '.repeat(depth)
      lines.push(`${indentation}- ${name}：${describeType(fieldSchema)}${describeRules(fieldSchema, requiredFields.has(name))}`)
      appendSchemaFields(fieldSchema, spec, lines, depth + 1, seenRefs)
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

  function formatOperation(spec, path, method, operation, pathItem) {
    const lines = []
    const title = cleanText(operation.summary || operation.description) || '未命名接口'

    lines.push(`接口名称：${title}`)
    if (operation.tags && operation.tags.length) lines.push(`所属分组：${operation.tags.join('、')}`)
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
        appendSchemaFields(schema, spec, lines, 1, new Set())
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
        appendSchemaFields(schema, spec, lines, 1, new Set())
      })
    }

    return lines.join('\n')
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

  function addCopyButtons() {
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
    })
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
