"""Review production renderer fixtures in Chromium; no account/network calls."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1] / '.test-results/i18n'
cases = json.loads((root / 'cases.json').read_text())
results, screenshots, switches = [], [], []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for case in cases:
        page = browser.new_page(viewport={'width': case['width'], 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('http://**/*', lambda route: route.abort())
        page.route('https://**/*', lambda route: route.abort())
        page.set_content(Path(case['file']).read_text(), wait_until='load')
        if case['view'] == 'images':
            state = json.loads((root / ('state-' + case['language'] + '.json')).read_text())
            page.evaluate('(s)=>window.dispatchEvent(new MessageEvent("message",{data:s}))', state)
            assert page.locator('#account').input_value() == state['draft']['accountId']
            assert page.locator('#prompt').input_value() == state['draft']['prompt']
            assert page.locator('.reference-thumb').evaluate('(n)=>n.naturalWidth') == 2
            assert '100.00%' not in page.locator('#imageQuotaStatus').inner_text()
            assert page.locator('#tasks img').count() == 1
            if case['width'] == 900 and case['theme'] == 'dark':
                # Pending input, an open advanced section, and an in-flight task
                # survive both client language event and delayed host projection.
                page.locator('#advanced').evaluate('(n)=>n.open=true')
                page.locator('#prompt').fill('未发送草稿 <script>literal</script>')
                page.locator('#prompt').blur()
                before = page.evaluate('({sent:sent.length,account:document.getElementById("account").value,model:document.getElementById("model").value})')
                opposite = 'en' if case['language'] == 'zh-CN' else 'zh-CN'
                busy = {**state, 'busy': True}
                page.evaluate('(s)=>window.dispatchEvent(new MessageEvent("message",{data:s}))', busy)
                # Simulate text edited just before host disables the form.
                page.locator('#prompt').evaluate('(n)=>n.value="未发送草稿 <script>literal</script>"')
                before['sent'] = page.evaluate('sent.length')
                page.evaluate('(language)=>window.dispatchEvent(new MessageEvent("message",{data:{type:"language",language}}))', opposite)
                translated = json.loads((root / ('state-' + opposite + '.json')).read_text())
                translated.update(busy=True, languageOnly=True)
                page.evaluate('(s)=>window.dispatchEvent(new MessageEvent("message",{data:s}))', translated)
                assert page.locator('#prompt').input_value() == '未发送草稿 <script>literal</script>'
                assert page.locator('#account').input_value() == before['account']
                assert page.locator('#model').input_value() == before['model']
                assert page.locator('#generate').is_disabled()
                assert page.locator('#cancel').is_enabled()
                assert page.locator('#advanced').evaluate('(n)=>n.open')
                assert page.locator('#tasks img').count() == 1
                assert page.locator('.reference-thumb').count() == 1
                assert page.evaluate('sent.length') == before['sent']
                assert page.locator('html').get_attribute('lang') == opposite
                assert page.locator('#count option[value="2"]').inner_text() == ('2 requests' if opposite == 'en' else '2 次')
                assert page.locator('#generate').inner_text() == ('Processing…' if opposite == 'en' else '正在处理…')
                switches.append({'from': case['language'], 'to': opposite, 'busy_draft_preserved': True, 'new_messages': 0})
                page.evaluate('(language)=>window.dispatchEvent(new MessageEvent("message",{data:{type:"language",language}}))', case['language'])
                page.evaluate('(s)=>window.dispatchEvent(new MessageEvent("message",{data:s}))', state)
        overflow = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
        assert overflow['scroll'] <= overflow['width'] + 1, (case, overflow)
        assert not errors, (case, errors)
        assert page.locator('html').get_attribute('lang') == case['language']
        if case['view'] == 'workbench':
            button = page.locator('button[data-command="live.capture"]')
            assert button.count() == 1
            assert button.is_disabled() == (case['save'] == 'saved')
        if case['language'] == 'en':
            # User text, model IDs and file paths are deliberately opaque.
            residue = page.evaluate('''()=>[...document.querySelectorAll('[data-i18n],button,summary,label,h1,h2,h3')].filter(n=>n.getClientRects().length&&/[\u3400-\u9fff]/.test(n.textContent)).map(n=>n.textContent)''')
            assert not residue, (case, residue)
        if case['width'] in [410,1440] and (case['view'] == 'images' or case['save'] in ['saved','update']):
            name = case['name'] + '-' + str(case['width']) + '.png'
            page.screenshot(path=str(root / name), full_page=True)
            screenshots.append(name)
        results.append({k: case[k] for k in ['view','language','theme','width'] } | {'save':case.get('save'),'horizontal_overflow':False,'script_errors':0})
        page.close()
    browser.close()
(root / 'browser-validation.json').write_text(json.dumps({'synthetic_data':True,'network_requests':0,'cases':results,'switches':switches,'screenshots':screenshots},indent=2)+'\n')
print(f'{len(results)} rendered cases passed; {len(switches)} in-flight language switches; {len(screenshots)} screenshots')
