// ==UserScript==
// @name         禅道一键完成
// @namespace    http://tampermonkey.net/
// @version      2025-04-02
// @description  禅道一键完成
// @author       You
// @match        http://zentao.chaomeifan.com/zentao/task-batchEdit-0-id_desc.html
// @icon         https://www.google.com/s2/favicons?sz=64&domain=chaomeifan.com
// @grant        none
// ==/UserScript==

;(function () {
  'use strict'
  const wrapper = document.querySelector('.main-header .btn-toolbar')
  wrapper.style = 'display: flex; align-items: center;'
  function createCompleteButton() {
    const button = document.createElement('button')
    button.style = 'margin-right: 10px;'
    button.innerHTML = '一键完成'
    wrapper.insertBefore(button, wrapper.children[0])
    button.addEventListener('click', () => {
      const tbody = document.querySelector('.table-responsive table tbody')
      const trs = tbody.querySelectorAll('tr')
      trs.forEach((tr) => {
        const tds = tr.querySelectorAll('td')
        // 设置状态为完成
        const select = tds[5].querySelector('select')
        select.value = 'done'
        // 设置工时
        const input = tds[8].querySelector('input')
        const random = Math.floor(Math.random() * 5) + 2
        input.value = random
      })
    })
  }
  createCompleteButton()
})()
