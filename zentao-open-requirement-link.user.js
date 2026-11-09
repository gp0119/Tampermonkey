// ==UserScript==
// @name         禅道打开需求链接
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  在需求描述标题旁添加按钮，一键打开描述中的链接
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/zentao-open-requirement-link.user.js
// @match        *://zentao.chaomeifan.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

;(function () {
  'use strict'

  for (const title of document.querySelectorAll('.detail > .detail-title')) {
    if (title.textContent.trim() !== '需求描述') continue

    const content = title.nextElementSibling
    if (!content?.matches('.detail-content')) continue

    const link = content.querySelector('a[href]:not([href=""])')
    if (!link || !['http:', 'https:'].includes(link.protocol)) continue

    const button = document.createElement('a')
    button.href = link.href
    button.target = link.target
    button.rel = 'noopener'
    button.className = 'btn btn-default btn-sm'
    button.style.marginInlineStart = 'auto'
    button.textContent = '打开需求链接'

    // 禅道可能把链接的 # 片段留在超链接后的文本里。
    const trailingText = link.nextSibling
    if (!link.hash && trailingText?.nodeType === Node.TEXT_NODE) {
      const fragment = trailingText.textContent.trim().match(/^#\S+/)?.[0]
      if (fragment) button.hash = fragment
    }

    title.style.display = 'flex'
    title.style.alignItems = 'center'
    title.style.columnGap = '8px'
    title.append(button)
  }
})()
