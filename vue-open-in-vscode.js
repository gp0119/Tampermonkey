// ==UserScript==
// @name         Vue 页面元素打开 Cursor
// @namespace    https://github.com/gp/Tampermonkey
// @version      1.3.6
// @description  选取 Vue 页面组件，通过 Alfred 在 Cursor 中打开对应 .vue 文件
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/vue-open-in-vscode.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/vue-open-in-vscode.js
// @match        *://z.gc.chaomeifan.com/*
// @match        *://xt.ty.chaomeifan.com/*
// @match        *://pg.chaomeifan.com/*
// @match        *://admin.p.chaomeifan.com/*
// @match        *://kt.chaomeifan.com/*
// @match        https://sj.chaomeifan.com/*
// @match        https://p.chaomeifan.com/operator/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

;(function () {
  'use strict'

  const projects = [
    { id: 'cg-mall-pc', root: '/Users/gp/zcckj/cg-mall-pc' },
    {
      id: 'factory-back-pc',
      apiPrefix: '/api/taiyi/',
      root: '/Users/gp/zcckj/factory-back-pc',
    },
    {
      id: 'guangcheng-back-pc',
      apiPrefix: '/api/guangcheng',
      root: '/Users/gp/zcckj/guangcheng-back-pc',
    },
    { id: 'mall-back-pc', root: '/Users/gp/zcckj/mall-back-pc' },
    { id: 'operator-mall-pc', root: '/Users/gp/zcckj/operator-mall-pc' },
    { id: 'pangu-back-pc', root: '/Users/gp/zcckj/pangu-back-pc' },
    { id: 'sj-mall-pc', root: '/Users/gp/zcckj/sj-mall-pc' },
    { id: 'warehouse', root: '/Users/gp/zcckj/warehouse' },
  ]
  const BUTTON_ID = 'vue-component-open-in-cursor-button'
  const ALFRED_TRIGGER_URL = 'alfred://runtrigger/com.gp.open-cursor/open/?argument='
  const PAGE_SOURCE_FUNCTION = '__vueOpenCursorSourceAtPoint'
  let selecting = false

  GM_addStyle(`
    #${BUTTON_ID} {
      position: fixed;
      z-index: 2147483647;
      right: 20px;
      bottom: 20px;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 50%;
      background: #42b883;
      color: #fff;
      box-shadow: 0 4px 14px rgb(0 0 0 / 25%);
      cursor: pointer;
      font: 700 16px/1 monospace;
    }

    #${BUTTON_ID}.is-selecting { background: #35495e; }

    .vue-route-open-in-cursor-toast {
      position: fixed;
      z-index: 2147483647;
      right: 20px;
      bottom: 74px;
      max-width: 300px;
      padding: 8px 12px;
      border-radius: 6px;
      background: #35495e;
      color: #fff;
      font: 13px/1.4 sans-serif;
    }
  `)

  function resourcePaths() {
    return performance.getEntriesByType('resource').map(({ name }) => new URL(name, location.href).pathname)
  }

  function detectProject(paths) {
    return projects.find(({ apiPrefix }) => apiPrefix && paths.some((path) => path.startsWith(apiPrefix)))
  }

  function sourceFile(component) {
    for (const candidate of [component, component?.$options, component?.type, component?.options, component?.resolved, component?.resolved?.options]) {
      if (candidate?.__file) return candidate.__file
    }
  }

  function installPageLookup() {
    try {
      unsafeWindow.eval(`
        window.${PAGE_SOURCE_FUNCTION} = function (x, y, includeShared) {
          function componentFile(component) {
            var options = component && (component.$options || component.type || component.options)
            return options && options.__file
          }

          function preferredFile(component) {
            var fallback
            for (var current = component; current; current = current.$parent || current.parent) {
              var source = componentFile(current)
              if (!source) continue
              fallback = fallback || source
              if (includeShared || source.indexOf('src/components/') !== 0) return source
            }
            return fallback
          }

          for (var element = document.elementFromPoint(x, y); element && element !== document.documentElement; element = element.parentElement) {
            var source = preferredFile(element.__vue__ || element.__vueParentComponent)
            if (source) return source
          }
        }
      `)
    } catch {}
  }

  function absoluteFile(source, project) {
    if (!source) return
    if (source.startsWith('/Users/')) return source

    const srcIndex = source.indexOf('src/')
    return srcIndex >= 0 && project ? `${project.root}/${source.slice(srcIndex)}` : undefined
  }

  function sourcePath(source) {
    const srcIndex = source?.indexOf('src/')
    return srcIndex >= 0 ? source.slice(srcIndex) : undefined
  }

  function projectForSource(source) {
    return projects.find(({ root }) => source?.startsWith(`${root}/`))
  }

  function showToast(message) {
    document.querySelector('.vue-route-open-in-cursor-toast')?.remove()
    const toast = document.createElement('div')
    toast.className = 'vue-route-open-in-cursor-toast'
    toast.textContent = message
    document.body.append(toast)
    setTimeout(() => toast.remove(), 2600)
  }

  function openInCursor(source) {
    const project = detectProject(resourcePaths()) ?? projectForSource(source)
    const file = absoluteFile(source, project)
    const relativeFile = sourcePath(source)
    if (!file && !relativeFile) {
      showToast('未定位源码：请确认当前页面发过 API，且生产包保留了 Vue 的 __file。')
      return
    }

    unsafeWindow.location.href = `${ALFRED_TRIGGER_URL}${encodeURIComponent(JSON.stringify({ projectId: project?.id, file, relativeFile }))}`
  }

  function selectedComponent(target) {
    for (let element = target; element && element !== document.documentElement; element = element.parentElement) {
      if (element.__vue__) return element.__vue__
      if (element.__vueParentComponent) return element.__vueParentComponent
    }
  }

  function stopSelecting() {
    selecting = false
    document.getElementById(BUTTON_ID)?.classList.remove('is-selecting')
    document.removeEventListener('click', selectComponent, true)
  }

  function selectComponent(event) {
    event.preventDefault()
    event.stopPropagation()
    stopSelecting()

    const target = unsafeWindow.document.elementFromPoint(event.clientX, event.clientY)
    const source = unsafeWindow[PAGE_SOURCE_FUNCTION]?.(event.clientX, event.clientY, event.altKey)
      ?? sourceFile(selectedComponent(target))
    if (!source) return showToast('未找到 Vue 组件源码。')
    openInCursor(source)
  }

  const button = document.createElement('button')
  button.id = BUTTON_ID
  button.type = 'button'
  button.textContent = '</>'
  button.title = '选取业务组件并在 Cursor 中打开源码（按住 Option 打开公共组件）'
  button.setAttribute('aria-label', button.title)
  button.addEventListener('click', () => {
    if (selecting) return stopSelecting()
    selecting = true
    button.classList.add('is-selecting')
    document.addEventListener('click', selectComponent, true)
    showToast('请点击业务组件；按住 Option 点击可打开公共组件。')
  })
  installPageLookup()
  document.body.append(button)

  // ponytail: only the two known API fingerprints are supported; add a project above when needed.
  console.assert(detectProject(['/api/taiyi/auth/token']).id === 'factory-back-pc')
  console.assert(detectProject(['/api/guangcheng/user']).id === 'guangcheng-back-pc')
  console.assert(projects.length === 8)
  console.assert(absoluteFile('webpack:///src/views/Home.vue', projects.find(({ id }) => id === 'factory-back-pc')) === '/Users/gp/zcckj/factory-back-pc/src/views/Home.vue')
  console.assert(sourcePath('webpack:///src/views/Home.vue') === 'src/views/Home.vue')
  console.assert(sourceFile({ $options: { __file: 'src/components/Panel.vue' } }) === 'src/components/Panel.vue')
})()
