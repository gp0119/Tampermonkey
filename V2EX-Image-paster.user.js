// ==UserScript==
// @name         V2EX Image paster
// @namespace    v2ex-image-paster
// @version      1.0.2
// @description  Automatically uploads pasted images to Imgur on V2EX input boxes
// @updateURL    https://raw.githubusercontent.com/gp0119/Tampermonkey/master/V2EX-Image-paster.user.js
// @downloadURL  https://raw.githubusercontent.com/gp0119/Tampermonkey/master/V2EX-Image-paster.user.js
// @match        https://www.v2ex.com/*
// @match        https://*
// @grant        GM_xmlhttpRequest
// @license      MIT
// ==/UserScript==

;(function () {
  'use strict'

  // 监听粘贴事件
  document.addEventListener('paste', function (event) {
    var items = (event.clipboardData || event.originalEvent.clipboardData).items
    for (var i = 0; i < items.length; i++) {
      var item = items[i]
      if (item.type.indexOf('image') !== -1) {
        // 获取粘贴的图片文件
        var file = item.getAsFile()

        // 上传图片到 Imgur
        uploadToImgur(file)
      }
    }
  })

  // 上传图片到 Imgur
  function uploadToImgur(file) {
    var textarea = document.activeElement
    var placeholder = '[上传中...]'

    // 插入loading占位符
    var startPos = textarea.selectionStart
    textarea.value = textarea.value.substring(0, startPos) + placeholder + textarea.value.substring(textarea.selectionEnd)
    textarea.setSelectionRange(startPos + placeholder.length, startPos + placeholder.length)

    var formData = new FormData()
    formData.append('image', file)

    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.imgur.com/3/image',
      headers: {
        Authorization: 'Client-ID 1c49486ec8e9565',
      },
      data: formData,
      onload: function (response) {
        var json = JSON.parse(response.responseText)
        console.log('response: ', json)
        // 替换占位符
        if (json.success) {
          var link = location.pathname.includes('/write') ? `![](${json.data.link})` : `\n${json.data.link}`
          textarea.value = textarea.value.replace(placeholder, link)
        } else {
          textarea.value = textarea.value.replace(placeholder, '[上传失败]')
        }
      },
      onerror: function () {
        textarea.value = textarea.value.replace(placeholder, '[上传失败]')
      },
    })
  }
})()
