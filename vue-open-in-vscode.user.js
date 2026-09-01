// ==UserScript==
// @name         Vue 页面元素打开 Cursor
// @namespace    https://github.com/gp/Tampermonkey
// @version      1.4.0
// @description  通过 Alfred 在 Cursor 中打开当前路由页面源码
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/vue-open-in-vscode.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/vue-open-in-vscode.user.js
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
      pagePrefix: 'xt.ty.chaomeifan.com/',
      root: '/Users/gp/zcckj/factory-back-pc',
    },
    {
      id: 'guangcheng-back-pc',
      apiPrefix: '/api/guangcheng',
      pagePrefix: 'z.gc.chaomeifan.com/',
      root: '/Users/gp/zcckj/guangcheng-back-pc',
    },
    { id: 'mall-back-pc', pagePrefix: 'admin.p.chaomeifan.com/', root: '/Users/gp/zcckj/mall-back-pc' },
    { id: 'operator-mall-pc', pagePrefix: 'p.chaomeifan.com/operator/', root: '/Users/gp/zcckj/operator-mall-pc' },
    { id: 'pangu-back-pc', pagePrefix: 'pg.chaomeifan.com/', root: '/Users/gp/zcckj/pangu-back-pc' },
    { id: 'sj-mall-pc', pagePrefix: 'sj.chaomeifan.com/', root: '/Users/gp/zcckj/sj-mall-pc' },
    { id: 'warehouse', pagePrefix: 'z.gc.chaomeifan.com/yz/', root: '/Users/gp/zcckj/warehouse' },
  ]
  const BUTTON_ID = 'vue-component-open-in-cursor-button'
  const ALFRED_TRIGGER_URL = 'alfred://runtrigger/com.gp.open-cursor/open/?argument='
  const ROUTE_SOURCE_FUNCTION = '__vueOpenCursorRouteSource'

  GM_addStyle(`
    #${BUTTON_ID} {
      position: fixed;
      z-index: 2147483647;
      left: 20px;
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

    .vue-route-open-in-cursor-toast {
      position: fixed;
      z-index: 2147483647;
      left: 20px;
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

  function projectForPage(page = `${location.hostname}${location.pathname}`) {
    return projects
      .filter(({ pagePrefix }) => pagePrefix && page.startsWith(pagePrefix))
      .sort((a, b) => b.pagePrefix.length - a.pagePrefix.length)[0]
  }

  function projectForApi(paths) {
    return projects.find(({ apiPrefix }) => apiPrefix && paths.some((path) => path.startsWith(apiPrefix)))
  }

  function detectProject(paths) {
    return projectForPage() ?? projectForApi(paths)
  }

  function installRouteLookup() {
    try {
      unsafeWindow.eval(`
        window.${ROUTE_SOURCE_FUNCTION} = function () {
          function findApp() {
            if (window.app && window.app.$router) return window.app
            var root = document.querySelector('#app')
            if (root && root.__vue__ && root.__vue__.$router) return root.__vue__
            var elements = document.querySelectorAll('*')
            for (var i = 0; i < elements.length; i++) {
              var component = elements[i].__vue__ || (elements[i].__vueParentComponent && elements[i].__vueParentComponent.proxy)
              if (component && component.$router) return component.$root || component
            }
          }

          function sourceFile(component) {
            var candidates = [component, component && component.$options, component && component.type, component && component.options, component && component.resolved, component && component.resolved.options]
            for (var i = 0; i < candidates.length; i++) {
              if (candidates[i] && candidates[i].__file) return candidates[i].__file
            }
          }

          var app = findApp()
          var matched = app && app.$route && app.$route.matched || []
          for (var i = matched.length - 1; i >= 0; i--) {
            var source = sourceFile(matched[i].components && matched[i].components.default)
            if (source) return source
          }
        }
      `)
    } catch {}
  }

  function sourcePath(source) {
    const srcIndex = source?.indexOf('src/')
    return srcIndex >= 0 ? source.slice(srcIndex) : undefined
  }

  function absoluteFile(source, project) {
    if (!source) return
    if (source.startsWith('/Users/')) return source
    const relativeFile = sourcePath(source)
    return relativeFile && project ? `${project.root}/${relativeFile}` : undefined
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

  function openInCursor() {
    const source = unsafeWindow[ROUTE_SOURCE_FUNCTION]?.()
    if (!source) {
      showToast('未能从当前路由定位页面源码。')
      return
    }

    const project = detectProject(resourcePaths()) ?? projectForSource(source)
    const file = absoluteFile(source, project)
    const relativeFile = sourcePath(source)
    if (!file && !relativeFile) {
      showToast('未能解析路由页面的源码路径。')
      return
    }

    unsafeWindow.location.href = `${ALFRED_TRIGGER_URL}${encodeURIComponent(JSON.stringify({ projectId: project?.id, file, relativeFile }))}`
  }

  const button = document.createElement('button')
  button.id = BUTTON_ID
  button.type = 'button'
  button.textContent = '</>'
  button.title = '在 Cursor 中打开当前路由页面源码'
  button.setAttribute('aria-label', button.title)
  button.addEventListener('click', openInCursor)
  installRouteLookup()
  document.body.append(button)

  console.assert(projectForApi(['/api/taiyi/auth/token']).id === 'factory-back-pc')
  console.assert(projectForApi(['/api/guangcheng/user']).id === 'guangcheng-back-pc')
  console.assert(projectForPage('xt.ty.chaomeifan.com/login').id === 'factory-back-pc')
  console.assert(projectForPage('z.gc.chaomeifan.com/yz/index').id === 'warehouse')
  console.assert(projectForPage('z.gc.chaomeifan.com/login').id === 'guangcheng-back-pc')
  console.assert(projectForPage('admin.p.chaomeifan.com/home').id === 'mall-back-pc')
  console.assert(projectForPage('p.chaomeifan.com/operator/product/list').id === 'operator-mall-pc')
  console.assert(projectForPage('pg.chaomeifan.com/login').id === 'pangu-back-pc')
  console.assert(projectForPage('sj.chaomeifan.com/product/list').id === 'sj-mall-pc')
  console.assert(projects.length === 8)
  console.assert(sourcePath('webpack:///src/views/Home.vue') === 'src/views/Home.vue')
})()
