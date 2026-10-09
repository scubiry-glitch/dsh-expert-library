/** Chromium acceptance: actual pages, OIDC+PKCE/RSA, PostgreSQL, HTTPS Git,
 * validation and signing workers. No session injection or mocked API replies. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createBrowserFixture } from '../support/browser-fixture.mjs'

const screenshotRoot = process.env.PACK_CENTER_BROWSER_SCREENSHOTS
  ? resolve(process.env.PACK_CENTER_BROWSER_SCREENSHOTS)
  : fileURLToPath(new URL('../../../../artifacts/pack-center/p3-web/', import.meta.url))

test('Chromium completes invited author → immutable Git review revision → independent publication and administration', { timeout: 240000 }, async t => {
  const fixture = await createBrowserFixture(t, { git: true })
  const { provider, publicOrigin, git, database, validator, publisher } = fixture
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.PACK_CENTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  t.after(() => browser.close())
  await mkdir(screenshotRoot, { recursive: true })
  const secrets = new Set(), browserErrors = [], browserAuthorizations = []
  async function user(subject) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' })
    // Test issuer's documented identity selector, and only that issuer request.
    // Browser still follows the center login, PKCE authorize, callback and cookie flow.
    await context.route(`${provider.issuer}authorize?*`, route => route.continue({ headers: {
      ...route.request().headers(), 'x-test-identity': Buffer.from(JSON.stringify({ subject })).toString('base64url'),
    } }))
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => browserErrors.push(error.name))
    page.on('request', request => { if (request.headers().authorization) browserAuthorizations.push(new URL(request.url()).pathname) })
    page.on('dialog', dialog => {
      if (dialog.type() === 'confirm') return dialog.accept()
      browserErrors.push('unexpected-dialog'); return dialog.dismiss()
    })
    return page
  }
  async function screenshot(page, name) {
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const text = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('input,textarea')].map(node => node.value).join('\n'))
    for (const secret of secrets) assert.equal(text.includes(secret), false, 'One-time secrets must be cleared before evidence capture')
    assert.doesNotMatch(text, /dpc_(?:bind|token)_[A-Za-z0-9_-]{43}/)
    await page.screenshot({ path: join(screenshotRoot, `${name}.png`), fullPage: true })
  }
  async function login(page, invitationToken) {
    await page.goto(publicOrigin)
    await page.getByTestId('login-submit').waitFor()
    if (invitationToken) await page.getByTestId('login-invitation').fill(invitationToken)
    const callback = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/callback')
    await page.getByTestId('login-submit').click()
    assert.equal((await callback).status(), 303)
    await page.getByTestId('logout').waitFor()
    assert.equal(new URL(page.url()).pathname, '/')
    assert.equal(new URL(page.url()).search, '')
    const cookies = await page.context().cookies(publicOrigin)
    assert.ok(cookies.some(cookie => cookie.name === 'pack-center-dev-session' && cookie.httpOnly))
    assert.ok(cookies.some(cookie => cookie.name === 'pack-center-dev-csrf' && !cookie.httpOnly))
    return page.evaluate(async () => (await (await fetch('/api/me')).json()).principal)
  }
  async function action(page, path, method, control, status = 200) {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method)
    await control.click()
    const actual = await response
    assert.equal(actual.status(), status, `${method} ${path} must succeed`)
    return actual.json()
  }
  async function route(page, path) {
    await page.goto(`${publicOrigin}/#/${path}`)
    await page.getByTestId('logout').waitFor()
  }
  async function status(page, state) { await page.locator(`[data-status="${state}"]`).first().waitFor() }
  async function noStoredSecrets(page) {
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    for (const secret of secrets) assert.equal(stored.includes(secret), false, 'Secrets must not persist in browser storage')
    assert.doesNotMatch(stored, /dpc_(?:bind|token)_/)
  }

  const admin = await user('admin'), developer = await user('developer'), reviewer = await user('reviewer')
  await admin.goto(publicOrigin)
  await admin.getByTestId('login-submit').waitFor()
  await screenshot(admin, '01-login')
  await admin.setViewportSize({ width: 390, height: 844 })
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await screenshot(admin, '13-mobile-login')
  await admin.setViewportSize({ width: 1440, height: 1050 })
  await admin.goto(`${publicOrigin}/api/auth/callback?code=invalid&state=invalid`)
  await admin.getByText(/登录未完成，可能是认证已过期/).waitFor()
  assert.equal(new URL(admin.url()).hash, '#/login-error')
  assert.equal(new URL(admin.url()).search, '')
  await login(admin)

  // Remaining selectors correspond to public form labels, not implementation
  // internals; all mutations below are triggered by actual page controls.
  await route(admin, 'organizations')
  const organizationName = '<img src=x onerror="globalThis.__packCenterXss=1"> Demo organization'
  for (const [id, name] of [['demo', organizationName], ['review-team', 'Independent review team']]) {
    await admin.locator('#organization-id').fill(id)
    await admin.locator('#organization-slug').fill(id)
    await admin.locator('#organization-name').fill(name)
    await action(admin, '/api/organizations', 'POST', admin.getByTestId('create-organization'), 201)
    await admin.waitForFunction(() => document.getElementById('organization-id')?.value === '')
  }
  await route(admin, 'organizations?organizationId=demo')
  await admin.getByRole('heading', { name: organizationName, exact: true }).waitFor()
  assert.equal(await admin.locator('img[src="x"]').count(), 0)
  assert.equal(await admin.evaluate(() => globalThis.__packCenterXss), undefined)

  async function invite(organization, roles) {
    await route(admin, `organizations?organizationId=${organization}`)
    for (const role of ['member', 'reviewer', 'admin']) await admin.locator(`#invite-role-${role}`).setChecked(roles.includes(role))
    const result = await action(admin, `/api/organizations/${organization}/invitations`, 'POST', admin.getByTestId('create-invitation'), 201)
    secrets.add(result.invitationToken)
    await admin.getByTestId('clear-secret').click()
    assert.equal(await admin.getByTestId('one-time-secret').count(), 0)
    return result.invitationToken
  }
  const developerPrincipal = await login(developer, await invite('demo', ['member', 'reviewer']))
  await admin.evaluate(async userId => {
    const csrf = document.cookie.split('; ').find(entry => entry.startsWith('pack-center-dev-csrf='))?.split('=')[1]
    const response = await fetch(`/api/users/${userId}/developer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ developer: true }) })
    if (!response.ok) throw new Error(`developer capability grant failed: ${response.status}`)
  }, developerPrincipal.userId)
  const reviewerPrincipal = await login(reviewer, await invite('review-team', ['reviewer']))
  for (const principal of [developerPrincipal, reviewerPrincipal]) {
    await route(admin, 'organizations?organizationId=demo')
    await admin.locator('#review-scope-user').fill(principal.userId)
    await action(admin, '/api/organizations/demo/review-scopes', 'POST', admin.getByTestId('save-review-scope'))
  }
  await screenshot(admin, '02-organization-members')
  await developer.reload()
  await reviewer.reload()

  await route(developer, 'submissions')
  await developer.getByText('没有符合条件的包。可调整筛选条件，或新建提交。', { exact: true }).waitFor()
  await screenshot(developer, '03-empty-submissions')
  await developer.setViewportSize({ width: 390, height: 844 })
  assert.equal(await developer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await screenshot(developer, '14-mobile-submissions')
  await developer.setViewportSize({ width: 1440, height: 1050 })
  await route(developer, 'submissions/new')
  await developer.getByTestId('submission-organization').selectOption('demo')
  await developer.getByTestId('submission-pack-id').fill('demo.review')
  await developer.getByTestId('submission-name').fill('<svg onload="globalThis.__packCenterXss=1">')
  await developer.getByTestId('submission-version').fill('1.0.0')
  await developer.getByTestId('submission-source-url').fill(git.input.url)
  await developer.getByTestId('submission-source-ref').fill('main')
  const notes = '<script>globalThis.__packCenterXss=1</script><img src=x onerror="globalThis.__packCenterXss=1"> Literal repository notes.'
  await developer.getByTestId('submission-notes').fill(notes)
  await developer.getByTestId('submission-license').fill('MIT')
  const save = developer.getByTestId('submission-save')
  // A dropped transport is not a mocked response. The real server receives no
  // mutation, and the form must not navigate or claim that the draft was saved.
  await developer.route(`${publicOrigin}/api/submissions`, route => route.request().method() === 'POST' ? route.abort('connectionfailed') : route.continue())
  await save.click()
  await developer.getByRole('alert').filter({ hasText: 'NETWORK_UNCONFIRMED' }).waitFor()
  assert.equal(new URL(developer.url()).hash, '#/submissions/new')
  assert.equal((await database.query('SELECT count(*)::int AS n FROM submissions')).rows[0].n, 0)
  await screenshot(developer, '04-unconfirmed-network-error')
  await developer.unroute(`${publicOrigin}/api/submissions`)
  const draft = await action(developer, '/api/submissions', 'POST', save, 201)
  await status(developer, 'draft')
  await developer.reload()
  await status(developer, 'draft')
  await developer.locator('pre').filter({ hasText: notes }).first().waitFor()
  assert.equal(await developer.locator('img[src="x"], svg[onload], script:not([src])').count(), 0)
  assert.equal(await developer.evaluate(() => globalThis.__packCenterXss), undefined)
  await screenshot(developer, '05-persistent-draft')

  // Exercise the real page lifecycle handlers in Chromium, without replacing
  // /api/me. Both direct identity refresh and BFCache-style restoration must
  // remove protected content synchronously, before reauthentication resolves.
  async function restoreProtectedDraft() {
    const checked = developer.waitForResponse(response => new URL(response.url()).pathname === '/api/me' && response.request().method() === 'GET')
    const cleared = await developer.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      return !document.querySelector('[data-testid="submission-form"], [data-testid="page-content"], [data-testid="logout"]')
        && document.body.innerText.includes('正在重新验证会话')
    })
    assert.equal(cleared, true, 'Identity refresh must clear protected DOM before any asynchronous response')
    assert.equal((await checked).status(), 200, 'Restoration must authenticate against the real center')
    await status(developer, 'draft')
    await developer.getByTestId('submission-form').waitFor()
    assert.equal(await developer.getByTestId('submission-notes').inputValue(), notes)
  }
  await restoreProtectedDraft()
  const hidden = await developer.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    return !document.querySelector('[data-testid="submission-form"], [data-testid="page-content"], [data-testid="logout"]')
      && document.body.innerText.includes('返回页面后将重新验证会话')
  })
  assert.equal(hidden, true, 'Pagehide must not leave protected content in a restorable document')
  await restoreProtectedDraft()

  const draftPath = `/api/submissions/${draft.id}`
  async function withDelayedPatch(check) {
    let release, entered, completed
    const gate = new Promise(resolve => { release = resolve })
    const intercepted = new Promise(resolve => { entered = resolve })
    const continued = new Promise(resolve => { completed = resolve })
    let cancellationExpected = false
    const handler = async route => {
      if (route.request().method() !== 'PATCH') return route.continue()
      entered(route.request())
      try { await gate; await route.continue() }
      catch (error) { if (!cancellationExpected) throw error }
      finally { completed() }
    }
    await developer.route(`${publicOrigin}${draftPath}`, handler)
    try { await check({ intercepted, release, continued, expectCancellation() { cancellationExpected = true } }) }
    finally { release(); await developer.unroute(`${publicOrigin}${draftPath}`, handler) }
  }
  const formLocked = () => developer.getByTestId('submission-form').evaluate(form => form.getAttribute('aria-busy') === 'true'
    && [...form.elements].every(control => control.disabled))
  await withDelayedPatch(async ({ intercepted, release, continued }) => {
    const saved = developer.waitForResponse(response => new URL(response.url()).pathname === draftPath && response.request().method() === 'PATCH')
    await developer.getByTestId('submission-save').click()
    await intercepted
    assert.equal(await formLocked(), true, 'All draft controls must remain locked while the real PATCH is pending')
    release()
    assert.equal((await saved).status(), 200)
    await continued
    await developer.waitForFunction(() => {
      const form = document.querySelector('[data-testid="submission-form"]')
      return form && form.getAttribute('aria-busy') !== 'true' && !form.querySelector('[data-testid="submission-notes"]').disabled
    })
    assert.equal(await developer.getByTestId('submission-organization').isDisabled(), true, 'Originally disabled controls stay disabled')
  })
  await withDelayedPatch(async ({ intercepted, release, continued, expectCancellation }) => {
    await developer.getByTestId('submission-notes').fill('Unsaved delayed content must never replace the refreshed draft.')
    await developer.getByTestId('submission-save').click()
    const pendingRequest = await intercepted
    assert.equal(await formLocked(), true)
    expectCancellation()
    const cancelled = developer.waitForEvent('requestfailed', request => request === pendingRequest)
    const refreshed = developer.waitForResponse(response => new URL(response.url()).pathname === draftPath && response.request().method() === 'GET')
    await developer.getByTestId('submission-refresh').click()
    assert.equal((await refreshed).status(), 200)
    await developer.getByTestId('submission-form').waitFor()
    assert.equal(await developer.getByTestId('submission-notes').inputValue(), notes)
    const currentForm = await developer.getByTestId('submission-form').elementHandle()
    release()
    await continued
    await cancelled
    await developer.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await currentForm.evaluate(form => form.isConnected), true, 'A cancelled old save must not replace the current render')
    assert.equal(await developer.getByTestId('submission-notes').inputValue(), notes)
    assert.equal(await developer.getByTestId('submission-notes').isDisabled(), false)
  })

  await action(developer, `/api/submissions/${draft.id}/validate`, 'POST', developer.getByTestId('submission-validate'), 202)
  await status(developer, 'validating')
  assert.equal((await validator.runOnce()).status, 'validated')
  await developer.reload()
  await status(developer, 'validated')
  const firstCommit = await git.git('rev-parse', 'HEAD')
  await developer.getByText(firstCommit, { exact: true }).waitFor()
  await screenshot(developer, '06-fixed-validation-report')
  const pending = await action(developer, `/api/submissions/${draft.id}/submit`, 'POST', developer.getByTestId('submission-submit'))
  await status(developer, 'pending_review')
  assert.equal(await developer.getByTestId('review-approved').isDisabled(), true)
  // Even a developer with reviewer role and scope cannot bypass independent
  // review with a handcrafted request from their real browser session.
  const selfReview = await developer.evaluate(async ({ id, stateVersion }) => {
    const detail = await (await fetch(`/api/submissions/${id}`)).json()
    const csrf = document.cookie.split('; ').find(value => value.startsWith('pack-center-dev-csrf='))?.split('=')[1]
    const result = await fetch(`/api/submissions/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ expectedVersion: stateVersion, contentTreeSha256: detail.snapshot.contentTreeSha256, decision: 'approved', comment: 'Self review must be denied' }) })
    return { status: result.status, code: (await result.json()).error.code }
  }, { id: draft.id, stateVersion: pending.stateVersion })
  assert.deepEqual(selfReview, { status: 403, code: 'SELF_REVIEW_DENIED' })

  await route(reviewer, 'reviews')
  await reviewer.getByRole('button', { name: `查看提交 ${draft.id}`, exact: true }).click()
  await status(reviewer, 'pending_review')
  await reviewer.getByTestId('review-comment').fill('Please revise the source before publication.')
  await action(reviewer, `/api/submissions/${draft.id}/review`, 'POST', reviewer.getByTestId('review-changes_requested'))
  await status(reviewer, 'changes_requested')
  await screenshot(reviewer, '07-independent-revision-request')

  await cp(fileURLToPath(new URL('../../../../examples/pack-center/demo-v2/', import.meta.url)), git.work, { recursive: true })
  await git.git('add', '.')
  await git.git('commit', '--quiet', '-m', 'browser-reviewed v2 revision')
  const revisedCommit = await git.push()
  assert.notEqual(revisedCommit, firstCommit)
  await developer.reload()
  await status(developer, 'changes_requested')
  await developer.getByTestId('submission-revise').click()
  await developer.getByTestId('submission-version').fill('1.1.0')
  await developer.getByTestId('submission-notes').fill('Revised source per independent review. ' + notes)
  const revised = await action(developer, '/api/submissions', 'POST', developer.getByTestId('submission-save'), 201)
  assert.equal(revised.previousSubmissionId, draft.id)
  assert.notEqual(revised.id, draft.id)
  await status(developer, 'draft')
  await action(developer, `/api/submissions/${revised.id}/validate`, 'POST', developer.getByTestId('submission-validate'), 202)
  assert.equal((await validator.runOnce()).status, 'validated')
  await developer.reload()
  await status(developer, 'validated')
  await developer.getByText(revisedCommit, { exact: true }).waitFor()
  await action(developer, `/api/submissions/${revised.id}/submit`, 'POST', developer.getByTestId('submission-submit'))
  await route(reviewer, `submissions/${revised.id}`)
  await reviewer.getByTestId('review-comment').fill('Approved the revised immutable snapshot after independent inspection.')
  const approved = await action(reviewer, `/api/submissions/${revised.id}/review`, 'POST', reviewer.getByTestId('review-approved'))
  await status(reviewer, 'approved')
  await status(reviewer, 'publishing')
  const gitRequests = git.requests.length
  assert.equal((await publisher.runOnce()).status, 'published')
  assert.equal(git.requests.length, gitRequests, 'Publication may not refetch mutable Git')
  await reviewer.reload()
  await status(reviewer, 'published')
  await screenshot(reviewer, '08-approved-published-revision')

  await route(admin, 'releases?organizationId=demo')
  await admin.getByText('demo.review', { exact: true }).first().waitFor()
  await screenshot(admin, '09-release-directory')
  await route(admin, `releases/${approved.releaseId}`)
  await status(admin, 'published')
  await screenshot(admin, '10-release-management')

  // Two separately managed deployment points; binding code is a one-time
  // display only. The admin browser must never obtain a machine credential.
  const points = []
  for (const name of ['Browser host A', '<img src=x onerror="globalThis.__packCenterXss=1"> Browser host B']) {
    await route(admin, 'deployments?organizationId=demo')
    await admin.locator('#deployment-name').fill(name)
    points.push(await action(admin, '/api/v1/deployments', 'POST', admin.getByTestId('create-deployment'), 201))
  }
  for (const point of points) {
    await route(admin, `deployments/${point.id}`)
    await admin.locator('#confirm-binding-issue').check()
    const code = await action(admin, `/api/v1/deployments/${point.id}/binding-codes`, 'POST', admin.getByTestId('issue-binding-code'), 201)
    secrets.add(code.bindingCode)
    await admin.getByTestId('one-time-secret').waitFor()
    assert.equal((await admin.getByTestId('one-time-secret').inputValue()) === code.bindingCode, true)
    const deniedExchange = await admin.evaluate(async bindingCode => {
      const result = await fetch('/api/v1/deployment-bindings/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingCode }) })
      const value = await result.json()
      return { status: result.status, hasToken: Object.hasOwn(value, 'credentialToken') }
    }, code.bindingCode)
    assert.deepEqual(deniedExchange, { status: 403, hasToken: false })
    await admin.reload()
    await admin.getByTestId('issue-binding-code').waitFor()
    assert.equal(await admin.getByTestId('one-time-secret').count(), 0)
    await admin.locator(`#revoke-binding-${code.bindingCodeId}`).check()
    await action(admin, `/api/v1/deployments/${point.id}/binding-codes/revoke`, 'POST', admin.getByTestId(`revoke-binding-${code.bindingCodeId}`))
    await admin.getByRole('cell', { name: '已撤销', exact: true }).waitFor()
    await admin.getByTestId('refresh-deployment').waitFor()
    await screenshot(admin, point === points[0] ? '11-deployment-a-revoked' : '12-deployment-b-revoked')
  }
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deployment_credentials')).rows[0].n, 0)
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deployment_binding_codes WHERE revoked_at IS NOT NULL')).rows[0].n, 2)
  assert.equal(await admin.locator('img[src="x"]').count(), 0)
  assert.equal(await admin.evaluate(() => globalThis.__packCenterXss), undefined)
  for (const page of [admin, developer, reviewer]) await noStoredSecrets(page)
  assert.deepEqual(browserAuthorizations, [])
  assert.deepEqual(browserErrors, [])
  assert.ok(provider.requests.authorize >= 3 && provider.requests.token >= 3 && provider.requests.jwks >= 1)
  assert.ok(git.requests.length >= 4, 'Validation used real smart HTTPS Git twice')
  const snapshots = (await database.query('SELECT source_commit FROM submission_snapshots ORDER BY source_commit')).rows.map(row => row.source_commit)
  assert.deepEqual(snapshots.sort(), [firstCommit, revisedCommit].sort())
  const audit = JSON.stringify((await database.query('SELECT * FROM audit_events')).rows)
  for (const secret of secrets) assert.equal(audit.includes(secret), false, 'Audit may not retain invitation or binding code plaintext')
  t.diagnostic(JSON.stringify({ browser: await browser.version(), realOidc: true, realPostgreSql: true, realHttpsGit: true,
    reviewRevision: true, independentApproval: true, signedPublication: true, twoDeploymentManagement: true,
    noBrowserMachineToken: true, screenshots: screenshotRoot }))
})
