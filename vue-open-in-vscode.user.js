// ==UserScript==
// @name         Vue 页面元素打开 Cursor
// @namespace    https://github.com/gp/Tampermonkey
// @version      1.4.2
// @description  通过 Alfred 在 Cursor 中打开当前路由页面源码
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/vue-open-in-vscode.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/vue-open-in-vscode.user.js
// @match        *://z.gc.chaomeifan.com/*
// @match        *://xt.ty.chaomeifan.com/*
// @match        *://pg.chaomeifan.com/*
// @match        *://admin.p.chaomeifan.com/*
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
    { id: 'operator-mall-pc', pagePrefix: 'p.chaomeifan.com/operator/', routeBase: '/operator', root: '/Users/gp/zcckj/operator-mall-pc' },
    { id: 'pangu-back-pc', pagePrefix: 'pg.chaomeifan.com/', root: '/Users/gp/zcckj/pangu-back-pc' },
    { id: 'sj-mall-pc', pagePrefix: 'sj.chaomeifan.com/', root: '/Users/gp/zcckj/sj-mall-pc' },
    { id: 'warehouse', pagePrefix: 'z.gc.chaomeifan.com/yz/', routeBase: '/yz', root: '/Users/gp/zcckj/warehouse' },
  ]
  const BUTTON_ID = 'vue-component-open-in-cursor-button'
  const ALFRED_TRIGGER_URL = 'alfred://runtrigger/com.gp.open-cursor/open/?argument='

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

  function routePathFor(pathname, base) {
    return base && (pathname === base || pathname.startsWith(`${base}/`)) ? pathname.slice(base.length) || '/' : pathname
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
    const project = detectProject(resourcePaths())
    if (!project) {
      showToast('未识别本地项目，暂不能定位路由源码。')
      return
    }

    unsafeWindow.location.href = `${ALFRED_TRIGGER_URL}${encodeURIComponent(JSON.stringify({ projectId: project.id, routePath: routePathFor(location.pathname, project.routeBase) }))}`
  }

  const button = document.createElement('button')
  button.id = BUTTON_ID
  button.type = 'button'
  button.textContent = '</>'
  button.title = '在 Cursor 中打开当前路由页面源码'
  button.setAttribute('aria-label', button.title)
  button.addEventListener('click', openInCursor)
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
  console.assert(routePathFor('/yz/purchase/page/orderRecord', '/yz') === '/purchase/page/orderRecord')
})()
