// ==UserScript==
// @name         Mukaku 详情页隐藏 VIP 遮罩
// @namespace    https://web5.mukaku.com/
// @version      1.1.0
// @description  隐藏影视详情页上的 VIP 遮罩并恢复资源区域交互
// @match        https://web5.mukaku.com/mv/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

/* global GM_addStyle */

GM_addStyle(`
  .vip-gate-overlay {
    display: none !important;
  }

  div:has(> .modern-main-tabs):has(> .resources-section-container) {
    filter: none !important;
    pointer-events: auto !important;
    user-select: auto !important;
  }
`)
