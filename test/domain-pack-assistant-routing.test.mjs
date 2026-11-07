import test from 'node:test'
import assert from 'node:assert/strict'
import { packAssistantAction } from '../lib/host/customer-capabilities.js'

test('domain pack assistant routes by requested operation, not status or negated trailing words', () => {
  assert.equal(packAssistantAction('请只读检查 zhijian-realestate 当前启用版本的结构问题；不要修改任何文件'), 'check')
  assert.equal(packAssistantAction('请说明如何更新 zhijian-realestate；不要修改、上传或提交'), 'update')
  assert.equal(packAssistantAction('请说明创建新领域包需要什么；不要新建任何包'), 'create')
  assert.equal(packAssistantAction('请说明下载领域包前要核对什么；不下载、不安装、不启用'), 'download')
  assert.equal(packAssistantAction('当前启用版本是什么'), undefined)
})
