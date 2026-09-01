// ==UserScript==
// @name         谷歌翻译绕过代码块(适配github,mathworks等)
// @version      1.0.1
// @description  让谷歌翻译插件翻译网页的时候，绕过代码块和一些无需翻译的元素
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/no-tanslate-code.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/no-tanslate-code.user.js
// @match        http*://*
// @license      MIT
// @grant        none
// ==/UserScript==
/*jshint esversion: 6 */
;(function () {
  'use strict'

  function noTranslate(array) {
    array.forEach((name) => {
      ;[...document.querySelectorAll(name)].forEach((node) => {
        if (node.className.indexOf('notranslate') === -1) {
          node.classList.add('notranslate')
        }
      })
    })
  }

  const bypassSelectorArray = [
    'pre',
    'code',
    '.prism-code',
    '.codeinput',
    '.CodeMirror-sizer',
    '.CodeMirror-lines',
    '.CodeMirror-scroll',
    '.CodeMirror-line',
    '.math',
    '.MathJax',
    '.MathJax_Display',
    '.MathRow',
    '.MathEquation',
    '.CodeBlock',
    '.MathJax_Preview',
    '.mjx-chtml.MJXc-display',
  ]
  if (window.location.hostname.indexOf('github') !== -1) {
    // 如果是github 还需要处理一些别的元素
    const githubSelector = [
      '.bg-gray-light.pt-3.hide-full-screen.mb-5',
      'summary.btn.css-truncate',
      '.commit-author',
      '.js-navigation-open.link-gray-dark',
      '.Box-title',
      '.BorderGrid-cell > div.mt-3 > a.muted-link',
      '.BorderGrid-cell > ul.list-style-none',
    ]
    bypassSelectorArray.push.apply(bypassSelectorArray, githubSelector)

    //如果还有github的插件 还需要延迟追加一些
    setTimeout(function () {
      const githubPluginSelector = ['.github-repo-size-div', '.octotree-tree-view']
      noTranslate(githubPluginSelector)
    }, 3000)
  }
  if (window.location.hostname.indexOf('mathworks') !== -1) {
    // 如果是mathworks
    const mathworksSelector = ['.codeinput', '.code_responsive', '.inlineequation', 'inline']
    bypassSelectorArray.push.apply(bypassSelectorArray, mathworksSelector)
  }
  noTranslate(bypassSelectorArray)

  setTimeout(function () {
    noTranslate(bypassSelectorArray)
  }, 2000)
  setTimeout(function () {
    noTranslate(bypassSelectorArray)
  }, 4000)
  setTimeout(function () {
    noTranslate(bypassSelectorArray)
  }, 6000)
  setTimeout(function () {
    noTranslate(bypassSelectorArray)
  }, 8000)
  setTimeout(function () {
    noTranslate(bypassSelectorArray)
  }, 10000)
})()
