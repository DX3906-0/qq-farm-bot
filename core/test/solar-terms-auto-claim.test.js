// 节令小札自动领取回归（2026-11-08）
// 背景：节令数据由独立的 SolarTermsService 提供，与已下线的「心许千灯星垂野」活动无关。
// 旧代码从 getStarActivity() 的 solarTerms 字段判断可领取数，该字段恒为空，
// 导致开关打开也永不领取（实测 11-07 立冬 term 403 一直未领）。
// 本测试直接提取真实源码函数，在 VM 中断言：不得因千灯活动下线而跳过领取。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../web/node_modules/typescript');

function loadTypeScriptConfig(relative) {
    const module = { exports: {} };
    const file = path.join(__dirname, '../../web/src', relative);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, Date, Intl }, { filename: file });
    return module.exports;
}
const solarConfig = loadTypeScriptConfig('config/solarTerms.ts');
const timeConfig = loadTypeScriptConfig('constants/activity-windows.ts');

async function renderSolarComponent(relative, props, transform = value => value, options = {}) {
    const { createRequire } = require('node:module');
    const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
    const vue = webRequire('vue');
    const renderer = webRequire('vue/server-renderer');
    const compiler = webRequire('vue/compiler-sfc');
    const filename = path.join(__dirname, '../../web/src', relative);
    const descriptor = compiler.parse(transform(fs.readFileSync(filename, 'utf8')), { filename }).descriptor;
    const script = compiler.compileScript(descriptor, { id: 'solar-panel-test', inlineTemplate: true,
        templateOptions: { ssr: true } });
    const module = { exports: {} };
    let BaseButton = vue.defineComponent({ props: ['disabled', 'loading'],
        setup(props, { slots }) { return () => vue.h('button', { disabled: props.disabled }, slots.default?.()); } });
    if (options.realButtons) {
        const buttonFile = path.join(__dirname, '../../web/src/components/ui/BaseButton.vue');
        const buttonDescriptor = compiler.parse(fs.readFileSync(buttonFile, 'utf8'), { filename: buttonFile }).descriptor;
        const buttonScript = compiler.compileScript(buttonDescriptor, { id: 'activity-button-test', inlineTemplate: true,
            templateOptions: { ssr: true } });
        const buttonModule = { exports: {} };
        vm.runInNewContext(ts.transpileModule(buttonScript.content, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText, { module: buttonModule, exports: buttonModule.exports, require(name) {
            if (name === 'vue') return vue;
            if (name === 'vue/server-renderer') return renderer;
            if (name === 'vue-router') return webRequire('vue-router');
            throw new Error(`禁止未声明按钮依赖: ${name}`);
        } }, { filename: buttonFile });
        BaseButton = buttonModule.exports.default;
    }
    vm.runInNewContext(ts.transpileModule(script.content, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, { module, exports: module.exports, require(name) {
        if (name === 'vue') return vue;
        if (name === 'vue/server-renderer') return renderer;
        if (name === '@/components/ui/BaseButton.vue') return BaseButton;
        if (name === '@/config/solarTerms') return solarConfig;
        throw new Error(`禁止未声明渲染依赖: ${name}`);
    } }, { filename });
    const app = vue.createSSRApp({ render: () => vue.h(module.exports.default, props) });
    return renderer.renderToString(app);
}

async function renderActivityHeader(count, transform = value => value, options = {}) {
    const file = path.join(__dirname, '../../web/src/views/Activity.vue');
    const source = fs.readFileSync(file, 'utf8');
    const header = source.slice(source.indexOf('    <header'), source.indexOf('    </header>') + '    </header>'.length);
    // 渲染实际header模板，而不是在测试中复制一份布局；状态和副作用依赖全部由夹具代替。
    const script = `<script setup lang="ts">
        import BaseButton from '@/components/ui/BaseButton.vue'
        import { solarTermName, solarTermStatusLabel } from '@/config/solarTerms'
        const vSlidingTabs = {}
        const props = defineProps<{ count: number, section: string, loading: boolean, hasTerm: boolean }>()
        const isSolarSection = props.section === 'notes', showStarTheme = false, headerBgSrc = '', headerOverlayClass = ''
        const activeSection = props.section, solarHeaderIllustration = '/activity/jieling/2026winter.png'
        const solarHeaderTerm = props.hasTerm ? { id: 403, title: '', status: 3, statusLabel: '' } : null
        const solarHeaderLabel = '已领取', solarSummary = { loading: props.loading }
        const currentAccount = { name: '离线夹具' }, currentAccountId = 'fixture'
        const activity = null, milkTeaActivity = null, heluLoading = props.loading, rainPoemLoading = false, gameBulletinPic = ''
        const milkTeaSchedule = { businessEnd: '11-14 24:00', rewardEnd: '11-16 24:00' }
        const userStore = { isAdmin: true }, L = { title: '活动中心', currentAccount: '当前账号', none: '-', refresh: '刷新' }
        const sections = [{ key: 'milk-tea', label: '奶茶热销中', icon: 'i-carbon-cafe', count: props.count }, { key: 'notes', label: '节令小礼', icon: 'i-carbon-notebook', count: props.count }]
        const activityPanelId = 'fixture-panel', activityTabNav = null, refreshingActivity = props.loading, selectedSection = props.section
        const activityHeading = props.section === 'notes' ? '节令小礼' : '奶茶热销中'
        const moveActivityTabFocus = () => {}, selectSection = () => {}, refreshAll = () => {}, showActivityAnalysis = false
    </script><template>${header}</template>`;
    return renderSolarComponent('views/Activity.vue', { count, section: options.section || 'notes',
        loading: !!options.loading, hasTerm: options.hasTerm !== false }, () => transform(script), options);
}

test('真实Vue节令面板SSR展示正确名称/状态和最新节令，无需生产网络', async () => {
    const terms = [
        { id: 101, title: '', status: 4, statusLabel: '状态4', claimable: false, startTime: 1, endTime: 30, rewards: [] },
        { id: 402, title: '', status: 5, statusLabel: '已结束', claimable: false, startTime: 40, endTime: 70, rewards: [] },
        { id: 403, title: '', status: 3, statusLabel: '已领取', claimable: false, startTime: 100, endTime: 200, rewards: [] },
    ];
    const html = await renderSolarComponent('components/activity/HeluSolarTermsPanel.vue', {
        labels: { notesTab: '节令小礼', empty: '暂无数据' }, solarTerms: { terms, nowTime: 150, claimableCount: 0 },
    });
    assert.match(html, /当前节令 立冬/);
    assert.match(html, /端午/);
    assert.match(html, /已过期未领取/);
    assert.match(html, /已过期已领取/);
    assert.doesNotMatch(html, /状态4|节令 101|心许千灯|星砂余额/);
});

test('节令真实卡片只显示奖励图标，冬季插画不能覆盖奖励或撑大卡片', async () => {
    const props = { labels: { notesTab: '节令小礼', empty: '暂无数据' }, solarTerms: {
        nowTime: 150, claimableCount: 0,
        terms: [{ id: 403, title: '', status: 3, claimable: false, startTime: 100, endTime: 200,
            rewards: [{ itemId: 20525, itemCount: 20, itemName: '油茶种子', image: '/fixture/seed.png' }] }],
    } };
    const html = await renderSolarComponent('components/activity/HeluSolarTermsPanel.vue', props);
    const assertRewards = value => {
        const card = value.match(/<article[\s\S]*?<\/article>/)?.[0] || '';
        assert.ok(card.includes('src="/fixture/seed.png"'), '卡片必须有真实奖励图');
        assert.doesNotMatch(card, /2026winter|官方冬季插画|object-cover/);
    };
    assertRewards(html);
    // 只在内存中恢复旧插画优先分支；测试必须能抓到旧缺陷，不修改生产文件。
    const oldHtml = await renderSolarComponent('components/activity/HeluSolarTermsPanel.vue', props, source => source
        .replace('currentSolarTerm, orderSolarTerms, solarTermName', 'currentSolarTerm, orderSolarTerms, solarTermIllustration, solarTermName')
        .replace('<img\n            v-if="term.rewards?.[0]?.image"', '<img v-if="solarTermIllustration(term)" :src="solarTermIllustration(term)" class="h-full w-full object-cover object-top">\n          <img\n            v-else-if="term.rewards?.[0]?.image"'));
    assert.throws(() => assertRewards(oldHtml), { name: 'AssertionError' });
    const empty = await renderSolarComponent('components/activity/HeluSolarTermsPanel.vue', {
        ...props, solarTerms: { ...props.solarTerms, terms: [{ ...props.solarTerms.terms[0], rewards: [] }] },
    });
    assert.doesNotMatch(empty, /2026winter/);
});

test('活动真实header小插画保持原比例且不会随屏宽放大撑高', async () => {
    const assertSize = html => {
        const image = html.match(/<img[^>]*src="\/activity\/jieling\/2026winter\.png"[^>]*>/)?.[0] || '';
        assert.match(image, /width="337"/);
        assert.match(image, /height="239"/);
        assert.match(image, /h-14 w-auto/);
        assert.match(image, /object-contain/);
        assert.doesNotMatch(image, /w-28|w-36|w-44|object-cover/);
    };
    assertSize(await renderActivityHeader(0));
    const old = await renderActivityHeader(0, source => source.replace('h-14 w-auto shrink-0 object-contain sm:h-16', 'h-auto w-28 shrink-0 rounded-lg sm:w-36 lg:w-44'));
    assert.throws(() => assertSize(old), { name: 'AssertionError' });
});

test('活动真实tab为0/1/99+保留同宽徽标且选中不切换字体粗细', async () => {
    const tabs = await Promise.all([0, 1, 120].map(count => renderActivityHeader(count)));
    const assertStable = html => {
        const button = (html.match(/<button[\s\S]*?<\/button>/g) || []).find(value => value.includes('节令小礼')) || '';
        assert.match(button, /font-medium/);
        assert.match(button, /<span[^>]*w-6[^>]*tabular-nums/);
    };
    tabs.forEach(assertStable);
    assert.match(tabs[0], /invisible[^>]*aria-hidden="true"/);
    assert.match(tabs[1], />1<\/span>/);
    assert.match(tabs[2], />99\+<\/span>/);
    const old = await renderActivityHeader(0, source => source.replace('<span\n            class="activity-tab-count ui-tab-count', '<span v-if="section.count"\n            class="activity-tab-count ui-tab-count'));
    assert.throws(() => assertStable(old), { name: 'AssertionError' });
});

test('活动双tab真实header：时间行保留占位、同边框与稳定控制区，不随奶茶/节令切换重排', async () => {
    const options = { realButtons: true };
    const milk = await renderActivityHeader(1, value => value, { ...options, section: 'milk-tea' });
    const solar = await renderActivityHeader(0, value => value, { ...options, section: 'notes' });
    const assertGeometry = (html, hidden) => {
        const header = html.match(/<header[^>]*>/)?.[0] || '';
        assert.match(header, /activity-header/);
        assert.match(html, /activity-tabs ui-tabs/);
        assert.match(html, /activity-banner ui-card/);
        assert.match(html, /activity-header-identity[^"<>]*min-w-0/);
        assert.match(html, /activity-header-controls/);
        assert.ok(html.indexOf('activity-tabs') < html.indexOf('activity-banner'), '导航必须独立于主题横幅');
        assert.doesNotMatch(header, /bg-\[#|text-amber|text-sky|text-white/);
        const schedule = html.match(/<p[^>]*activity-header-schedule[\s\S]*?<\/p>/)?.[0] || '';
        assert.ok(schedule, '两页必须都有相同的时间行DOM，占位不能v-if删除');
        assert.match(schedule, /经营至 <strong[^>]*>11-14 24:00<\/strong>/);
        assert.match(schedule, /领奖至 <strong[^>]*>11-16 24:00<\/strong>/);
        if (hidden) { assert.match(schedule, /invisible/); assert.match(schedule, /aria-hidden="true"/); }
        else assert.doesNotMatch(schedule, /invisible/);
    };
    assertGeometry(milk, false); assertGeometry(solar, true);
    const old = await renderActivityHeader(0, source => source.replace(
        '<p\n            class="activity-header-schedule', '<p v-if="activeSection === \'milk-tea\'"\n            class="activity-header-schedule'),
    { ...options, section: 'notes' });
    assert.throws(() => assertGeometry(old, true), { name: 'AssertionError' });
});

test('活动双tab实际BaseButton：刷新loading前后固定宽度，视口滚动条出现/消失保留占位', async () => {
    const idle = await renderActivityHeader(0, value => value, { section: 'milk-tea', realButtons: true });
    const loading = await renderActivityHeader(0, value => value, { section: 'notes', realButtons: true, loading: true });
    for (const html of [idle, loading]) {
        const refresh = html.match(/<button[^>]*activity-header-refresh[\s\S]*?<\/button>/)?.[0] || '';
        assert.match(refresh, /w-24/);
        assert.match(refresh, /shrink-0/);
    }
    const layout = fs.readFileSync(path.join(__dirname, '../../web/src/layouts/DefaultLayout.vue'), 'utf8');
    assert.match(layout, /\.custom-scrollbar\s*\{[^}]*scrollbar-gutter:\s*stable;/);
});

test('活动Edge像素回归：双tab/空详情/加载/0及99+徽标/长短内容的按钮坐标不变', {
    skip: process.env.FARM_EDGE_LAYOUT_TEST !== '1',
}, async () => {
    const { execFileSync } = require('node:child_process');
    const build = process.env.FARM_LAYOUT_BUILD_DIR;
    const edge = process.env.FARM_EDGE_EXECUTABLE;
    const tempRoot = process.env.TMPDIR;
    assert.ok(build && edge && tempRoot);
    assert.ok(fs.statSync(build).isDirectory() && fs.statSync(tempRoot).isDirectory());
    const directory = fs.mkdtempSync(path.join(tempRoot, 'activity-layout-'));
    const cssFiles = fs.readdirSync(path.join(build, 'assets')).filter(name => /^(vendor-|index-|DefaultLayout-|Activity-).*\.css$/.test(name));
    const css = cssFiles.map(name => fs.readFileSync(path.join(build, 'assets', name), 'utf8')).join('\n');
    const winter = `data:image/png;base64,${fs.readFileSync(path.join(build, 'activity/jieling/2026winter.png')).toString('base64')}`;
    const states = [
        { section: 'milk-tea', count: 0, hasTerm: true, loading: false, bodyHeight: 1400 },
        { section: 'notes', count: 0, hasTerm: false, loading: false, bodyHeight: 120 },
        { section: 'notes', count: 1, hasTerm: true, loading: false, bodyHeight: 120 },
        { section: 'notes', count: 120, hasTerm: true, loading: true, bodyHeight: 1400 },
        { section: 'milk-tea', count: 120, hasTerm: true, loading: false, bodyHeight: 1400 },
    ];
    const legacy = source => source
        .replace('activity-banner ui-card', 'activity-banner ui-card legacy-no-height')
        .replace('activity-tab-count inline-block w-6 shrink-0', 'activity-tab-count inline-block shrink-0')
        .replace('<p\n            class="activity-header-schedule', '<p v-if="activeSection === \'milk-tea\'"\n            class="activity-header-schedule')
        .replace('class="activity-header-refresh w-24 shrink-0"', 'class="activity-header-refresh"');
    const render = async transform => Promise.all(states.map(state => renderActivityHeader(state.count, transform,
        { ...state, realButtons: true }).then(html => ({ html: html.replaceAll('/activity/jieling/2026winter.png', winter), bodyHeight: state.bodyHeight }))));
    const fixtures = { current: await render(value => value), legacy: await render(legacy) };
    const script = `const fixtures=${JSON.stringify(fixtures)};
        const shell=document.getElementById('shell'),stage=document.getElementById('stage'),body=document.getElementById('content');
        function measure(list,stable){shell.style.scrollbarGutter=stable?'stable':'auto';return list.map(item=>{
          stage.innerHTML=item.html;body.style.height=item.bodyHeight+'px';shell.scrollTop=0;
          const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
          return{header:rect(stage.querySelector('header')),tabs:[...stage.querySelectorAll('button')]
            .filter(b=>/奶茶热销中|节令小礼/.test(b.textContent)).map(rect),refresh:rect(stage.querySelector('.activity-header-refresh'))};
        })}
        const current=measure(fixtures.current,true),legacy=measure(fixtures.legacy,false);
        const drift=rows=>Math.max(...rows.flatMap(row=>row.tabs.flatMap((r,i)=>Object.keys(r).map(k=>Math.abs(r[k]-rows[0].tabs[i][k])))));
        const report={viewport:innerWidth,current,legacy,currentDrift:drift(current),legacyDrift:drift(legacy)};
        document.getElementById('geometry-result').textContent=JSON.stringify(report);
        if(parent!==window)parent.postMessage({activityLayout:report},'*');`;
    const file = path.join(directory, 'fixture.html');
    fs.writeFileSync(file, `<!doctype html><html><head><meta charset="UTF-8"><style>${css}
        body{margin:0}.legacy-no-height{min-height:0}.layout-shell{height:600px;overflow-y:auto;padding:24px;scrollbar-gutter:stable}
        @media(min-width:1024px){.layout-shell{margin-left:240px}}</style></head>
        <body><main id="shell" class="layout-shell custom-scrollbar"><div id="stage"></div><div id="content"></div></main>
        <pre id="geometry-result"></pre><script>${script}</script></body></html>`, 'utf8');
    const { pathToFileURL } = require('node:url');
    const results = [];
    for (const width of [375, 768, 1024, 1280, 1440]) {
        // Edge顶层窗口有最小宽度和系统缩放；iframe给CSS媒体查询提供精确视口，不猜测375px已测到。
        const wrapper = path.join(directory, `viewport-${width}.html`);
        fs.writeFileSync(wrapper, `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0">
            <pre id="geometry-result"></pre><script>addEventListener('message',e=>{
              if(e.data?.activityLayout)document.getElementById('geometry-result').textContent=JSON.stringify(e.data.activityLayout)
            });</script><iframe src="fixture.html" style="width:${width}px;height:768px;border:0"></iframe></body></html>`, 'utf8');
        const html = execFileSync(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking',
            '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--dump-dom',
            '--virtual-time-budget=1200', `--window-size=${width},768`, `--user-data-dir=${path.join(directory, 'edge-profile')}`,
            pathToFileURL(wrapper).href], { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] });
        const encoded = html.match(/<pre id="geometry-result">([^<]+)<\/pre>/)?.[1];
        assert.ok(encoded, `Edge ${width}px未输出坐标，不能只凭CSS类名验收`);
        const result = JSON.parse(encoded.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
        assert.equal(result.viewport, width, '测量必须采用所要求的真实CSS视口宽度');
        if (result.currentDrift > 0.25) console.log('ACTIVITY_LAYOUT_FAILURE', JSON.stringify(result));
        assert.ok(result.currentDrift <= 0.25, `${width}px新布局仍移动${result.currentDrift}px`);
        assert.ok(result.legacyDrift > 1, `${width}px旧布局未复现跳变，夹具不能作为验收`);
        results.push({ viewport: result.viewport, currentDrift: result.currentDrift, legacyDrift: result.legacyDrift });
    }
    console.log('ACTIVITY_LAYOUT_PIXELS', JSON.stringify(results));
});

test('官方节令V1状态4未领过期、5已领过期，前端不再显示含糊状态4/已结束', () => {
    assert.equal(solarConfig.solarTermStatusLabel({ status: 4, statusLabel: '状态4' }), '已过期未领取');
    assert.equal(solarConfig.solarTermStatusLabel({ status: 5, statusLabel: '已结束' }), '已过期已领取');
    assert.equal(solarConfig.solarTermStatusLabel({ status: 3, statusLabel: '' }), '已领取');
    const activitySource = fs.readFileSync(path.join(__dirname, '../src/services/activity.js'), 'utf8');
    const begin = activitySource.indexOf('const SOLAR_TERM_NAMES =');
    const end = activitySource.indexOf('\nfunction normalizeSolarTerm(', begin);
    const api = vm.runInNewContext(activitySource.slice(begin, end) + '\n({ names: SOLAR_TERM_NAMES, label: solarStatusLabel })');
    assert.equal(api.names[101], '端午');
    assert.equal(api.label(4), '已过期未领取');
    assert.equal(api.label(5), '已过期已领取');
});

test('官方名称映射显示端午/夏至/立冬，未来未知ID保留编号而不猜', () => {
    assert.equal(solarConfig.solarTermName({ id: 101, title: '' }), '端午');
    assert.equal(solarConfig.solarTermName({ id: 102, title: '' }), '夏至');
    assert.equal(solarConfig.solarTermName({ id: 403, title: '' }), '立冬');
    assert.equal(solarConfig.solarTermName({ id: 999, title: '' }), '节令 999');
    assert.equal(solarConfig.solarTermName({ id: 101, title: '服务端新名称' }), '服务端新名称');
});

test('当前节令按真实时间窗确定，不能从列表第一条或历史已领记录挑选', () => {
    const current = { id: 403, startTime: 100, endTime: 200 };
    const old = { id: 101, startTime: 1, endTime: 30 };
    const future = { id: 404, startTime: 300, endTime: 400 };
    assert.equal(solarConfig.currentSolarTerm([old, future, current], 150).id, 403);
    assert.equal(solarConfig.currentSolarTerm([old, future, current], 200).id, 403);
    assert.equal(solarConfig.currentSolarTerm([old, future, current], 250).id, 403);
    assert.equal(solarConfig.currentSolarTerm([future], 150), null);
});

test('节令当前/最新置顶，历史倒序，未来不挤掉当前，不修改服务端快照', () => {
    const olderOpen = { id: 401, startTime: 80, endTime: 200 };
    const latestOpen = { id: 403, startTime: 100, endTime: 200 };
    const history = { id: 402, startTime: 90, endTime: 120 };
    const future = { id: 404, startTime: 300, endTime: 400 };
    const unknown = { id: 999, startTime: 0, endTime: 0 };
    const input = [olderOpen, future, history, unknown, latestOpen];
    const snapshot = JSON.stringify(input);
    assert.deepEqual(Array.from(solarConfig.orderSolarTerms(input, 150), value => value.id), [403, 401, 402, 404, 999]);
    assert.equal(solarConfig.currentSolarTerm(input, 150).id, 403, '重合窗口也取最新，不取服务端第一行');
    assert.deepEqual(Array.from(solarConfig.orderSolarTerms(input, 250), value => value.id), [403, 402, 401, 404, 999]);
    assert.equal(JSON.stringify(input), snapshot, '排序不可原地sort覆盖接口顺序');
    assert.deepEqual(Array.from(solarConfig.orderSolarTerms([unknown, { id: 998, startTime: NaN, endTime: 0 }], 150), value => value.id), [999, 998]);
    const vue = fs.readFileSync(path.join(__dirname, '../../web/src/views/SolarCalendar.vue'), 'utf8');
    assert.match(vue, /const events = computed\(\(\) => orderSolarTerms\(/);
    assert.match(vue, /const featuredEvent = computed/);
    assert.match(vue, /:data-event-id="event.id"/);
    assert.match(vue, /seasonEntries/);
});

test('奶茶活动首位并默认打开，节令小礼最后且不再用千灯标题/星砂主题', () => {
    const view = fs.readFileSync(path.join(__dirname, '../../web/src/views/Activity.vue'), 'utf8');
    const begin = view.indexOf('const sections = computed<ActivitySection[]>');
    const end = view.indexOf('let disposed =', begin);
    const list = view.slice(begin, end);
    assert.ok(list.indexOf("key: 'milk-tea'") < list.indexOf("key: 'qixi'"));
    assert.ok(list.lastIndexOf("key: 'notes'") > list.lastIndexOf("key: 'share-reward'"));
    assert.match(view, /const activeSection = ref<ActivitySectionKey \| ''>\('milk-tea'\)/);
    assert.match(view, /if \(isSolarSection\.value\) return '节令小礼'/);
    assert.match(view, /<h1>\{\{ L\.title \}\}<\/h1>/);
    assert.match(view, /<h2>\{\{ activityHeading \}\}<\/h2>/);
    assert.match(view, /v-if="showStarTheme && activity"[\s\S]*?star-token\.png/);
    const file = path.join(__dirname, '../../web/public', solarConfig.SOLAR_TERM_ASSETS.winter);
    assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('奶茶经营与领奖截止按北京时间独立展示；缺时间不伪造', () => {
    assert.equal(timeConfig.formatActivityDeadline(1794671999), '11月14日 24:00');
    assert.equal(timeConfig.formatActivityDeadline(1794844799), '11月16日 24:00');
    assert.equal(timeConfig.formatActivityDeadline(undefined), '时间待确认');
    const view = fs.readFileSync(path.join(__dirname, '../../web/src/views/Activity.vue'), 'utf8');
    assert.match(view, /businessEnd: formatActivityDeadline\(state\?\.settleStartTime\)/);
    assert.match(view, /rewardEnd: formatActivityDeadline\(state\?\.endTime\)/);
});

const source = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
const start = source.indexOf('async function runStarActivityAutoClaims()');
const end = source.indexOf('\nfunction stopStarActivityClaimTimer(', start);
assert.ok(start > 0 && end > start, '必须能提取到 runStarActivityAutoClaims');

// 被调用函数引用了 worker 顶层的常量表，按源码原样一并提取，避免在测试里复刻一份易失真的副本。
function extractConst(name) {
    const begin = source.indexOf(`const ${name} = {`);
    assert.ok(begin >= 0, `必须能提取到 ${name}`);
    const close = source.indexOf('\n};', begin);
    assert.ok(close > begin, `必须能提取到 ${name} 的结尾`);
    return source.slice(begin, close + 3);
}
const milkTeaConsts = `${extractConst('MILK_TEA_AUTO_ACTIONS')}\n${extractConst('MILK_TEA_ACTION_LABELS')}`;

function buildHarness({ automation, solarTerms, starTouched, milkTeaApi, sourceTransform, solarV2 }) {
    const logs = [];
    const claimed = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        Date,
        Number,
        Promise,
        require(id) {
            if (id === '../models/store') {
                return {
                    getInactiveActivityAutomationKeys: () => new Set(),
                };
            }
            if (id === '../services/activity') {
                // 领取后服务端会把该 term 置为已领取，这里如实模拟状态推进，
                // 否则会误导成"循环会重复领取同一个节令"。
                let pending = [{ id: 403, claimable: true, title: '立冬' }];
                return {
                    QINGMEI_WINE_END_TIME: 0,
                    getStarActivity: async () => { starTouched.value = true; return { solarTerms: { claimableCount: 0 } }; },
                    claimSeasonPassportRewards: async () => ({ claimedLevels: 1 }),
                    claimStarRecordRewards: async () => ({ recordIds: [] }),
                    claimQingmeiSeeds: async () => ({}),
                    brewAndSellQingmeiWine: async () => ({}),
                    getSolarTermsInfo: async () => ({
                        terms: pending.map(t => ({ ...t })),
                        claimableCount: pending.filter(t => t.claimable).length,
                    }),
                    claimSolarTermsReward: async (id) => {
                        claimed.push(id);
                        pending = pending.map(t => (t.id === id ? { ...t, claimable: false } : t));
                        return { rewards: [{ id: 1001, count: 1 }], term: { title: '立冬', status: 3 }, solarTerms: { terms: [{ id: 403, status: 3 }] } };
                    },
                    ...milkTeaApi,
                };
            }
            if (id === '../services/solar-calendar') return { autoClaimSolarGifts: typeof solarV2 !== 'undefined' && solarV2 || (async () => ({ handledIds: [], results: [] })) };
            if (id === '../services/honghua-activity') {
                return { getHonghuaActivity: async () => ({}), claimHonghuaShare: async () => ({}), claimHonghuaTiers: async () => ({}), donateHonghuaLove: async () => ({}) };
            }
            throw new Error(`未声明依赖 ${id}`);
        },
    });
    // 补齐函数依赖的外部符号：只替换本次调用路径需要的部分。
    const prelude = `
        let starActivityClaimRunning = false;
        let loginReady = true;
        let friendSyncPaused = false;
        const getAutomation = () => (${JSON.stringify(automation)});
        const getInactiveActivityAutomationKeys = () => new Set();
        const log = (tag, msg, meta) => __logs.push({ tag, msg, meta });
        const workerScheduler = { setTimeoutTask() {}, setIntervalTask() {}, clear() {} };
        const milkTeaSkipLoggedAt = new Map(), MILK_TEA_SKIP_LOG_INTERVAL_MS = 600000;
        const isTransientNetworkError = () => false;
        const __logs = [];
    `;
    const body = sourceTransform ? sourceTransform(source.slice(start, end)) : source.slice(start, end);
    vm.runInContext(prelude + milkTeaConsts + '\n' + body + '\n;globalThis.run = runStarActivityAutoClaims; globalThis.logsRef = __logs;', context);
    return { context, logs: () => context.logsRef || [], claimed };
}

test('千灯活动下线不影响节令领取：开关打开时必须真的领取立冬', async () => {
    const starTouched = { value: false };
    const h = buildHarness({
        automation: { solar_terms_claim: true },
        solarTerms: null,
        starTouched,
    });
    await h.context.run();
    assert.deepEqual(h.claimed, [403], '必须走到 claimSolarTermsReward 并领取 term 403');
    assert.equal(starTouched.value, false, '不得为了节令去请求已下线的千灯活动');
    const ok = h.logs().filter(l => l.meta && l.meta.event === '节令小札自动领取');
    assert.ok(ok.length >= 1, '必须有节令领取日志，便于面板与日志排查');
    assert.ok(ok.some(l => l.meta.result === 'success' && l.meta.termId === 403));
});

test('V2基础小礼复用原开关，同编号V1不再重复领取，无自动答题/季度领奖', async () => {
    const calls = [];
    const h = buildHarness({ automation: { solar_terms_claim: true }, starTouched: { value: false },
        solarV2: async () => { calls.push('v2'); return { handledIds: [403], results: [{ id: 403, name: '立冬', resultState: 'completed', rewards: [{ id: 1001, count: 20 }] }] }; } });
    await h.context.run();
    assert.deepEqual(calls, ['v2']); assert.deepEqual(h.claimed, []);
    assert.ok(h.logs().some(item => item.meta?.version === 2 && item.meta?.result === 'success'));
    const worker = source.slice(start, end);
    const autoSmallGift = worker.slice(worker.indexOf('if (claimSolarTermsEnabled)'), worker.indexOf('if (solarQuizNotifyEnabled || solarAutoAnswerEnabled)'));
    assert.doesNotMatch(autoSmallGift, /autoAnswerSolarQuizzes|AnswerSolarTerms|ClaimSolarSeason/);
});

test('V2读取或领取unknown不会降级发V1同奖，原开关关闭连V2都不读', async () => {
    let reads = 0;
    const run = async () => { reads++; throw Object.assign(new Error('unknown'), { resultState: 'unknown' }); };
    const enabled = buildHarness({ automation: { solar_terms_claim: true }, starTouched: { value: false }, solarV2: run });
    await enabled.context.run(); assert.equal(reads, 1); assert.equal(enabled.claimed.length, 0);
    assert.ok(enabled.logs().some(item => item.meta?.result === 'error'));
    const disabled = buildHarness({ automation: { solar_terms_claim: false }, starTouched: { value: false }, solarV2: run });
    await disabled.context.run(); assert.equal(reads, 1); assert.equal(disabled.claimed.length, 0);
});

function workerGoldSeedPolicy() {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/activity.js'), 'utf8');
    const begin = source.indexOf('function milkTeaCostItemId(');
    const end = source.indexOf('/** 库存是否够付', begin);
    return vm.runInNewContext(source.slice(begin, end) + '\n isMilkTeaGoldSeed', { toNum: value => Number(value) || 0 });
}

test('奶茶真实worker循环只预选纯金币种子并传auto:true，旧入口漏标记能被回归抓到', async () => {
    const isMilkTeaGoldSeed = workerGoldSeedPolicy();
    const operations = [];
    const state = { active: true, phase: 'business', summary: { shopOpenAt: 1 }, goods: [
        { categoryTag: 'seed', costs: [{ itemId: 1041, count: 10 }], unlocked: true, remaining: 1, affordable: true },
        { categoryTag: 'seed', costs: [{ itemId: 1001, count: 10 }], unlocked: true, remaining: 1, affordable: true },
    ] };
    const options = { automation: { milk_tea_seed_buy: true }, starTouched: { value: false }, milkTeaApi: {
        getMilkTeaActivity: async page => { assert.equal(page, 'exchange'); return state; }, isMilkTeaGoldSeed,
        operateMilkTeaActivity: async (action, params) => { operations.push({ action, params: { ...params } }); return { ok: true }; },
    } };
    const h = buildHarness(options);
    await h.context.run();
    assert.deepEqual(operations, [{ action: 'seedBuy', params: { count: 1, auto: true } }]);
    assert.ok(h.logs().some(item => item.meta?.result === 'success'));
    operations.length = 0;
    state.goods = [state.goods[0]];
    await h.context.run();
    assert.equal(operations.length, 0, '只剩券商品不得进入服务购种');
    assert.doesNotMatch(h.logs().map(item => item.msg).join(' '), /失败/);
    state.goods = [{ categoryTag: 'seed', costs: [{ itemId: 1001, count: 10 }], unlocked: true, remaining: 1, affordable: true }];
    const old = buildHarness({ ...options, sourceTransform: source => source.replace("if (action === 'seedBuy') { params.count = 1; params.auto = true; }", "if (action === 'seedBuy') params.count = 1;") });
    await old.context.run();
    assert.throws(() => assert.equal(operations[0].params.auto, true), { name: 'AssertionError' });
});

test('未开启节令开关时不得发起领取', async () => {
    const starTouched = { value: false };
    const h = buildHarness({
        automation: { solar_terms_claim: false, milk_tea_auto_claim: true },
        solarTerms: null,
        starTouched,
    });
    await h.context.run();
    assert.deepEqual(h.claimed, []);
});

test('服务端状态未推进时不得重复领取同一个节令（幂等保护）', async () => {
    const starTouched = { value: false };
    const claimed = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} }, Date, Number, Promise,
        require(id) {
            if (id === '../models/store') return { getInactiveActivityAutomationKeys: () => new Set() };
            if (id === '../services/activity') {
                return {
                    QINGMEI_WINE_END_TIME: 0,
                    getStarActivity: async () => { starTouched.value = true; return {}; },
                    claimSeasonPassportRewards: async () => ({ claimedLevels: 0 }),
                    claimStarRecordRewards: async () => ({ recordIds: [] }),
                    claimQingmeiSeeds: async () => ({}),
                    brewAndSellQingmeiWine: async () => ({}),
                    // 永远报告 403 可领取：模拟服务端回包状态延迟或客户端读取到旧快照。
                    getSolarTermsInfo: async () => ({ terms: [{ id: 403, claimable: true }], claimableCount: 1 }),
                    claimSolarTermsReward: async (id) => { claimed.push(id); return { rewards: [{ id: 1001, count: 1 }], term: { title: '立冬', status: 3 }, solarTerms: { terms: [{ id: 403, status: 3 }] } }; },
                };
            }
            if (id === '../services/solar-calendar') return { autoClaimSolarGifts: typeof solarV2 !== 'undefined' && solarV2 || (async () => ({ handledIds: [], results: [] })) };
            if (id === '../services/honghua-activity') {
                return { getHonghuaActivity: async () => ({}), claimHonghuaShare: async () => ({}), claimHonghuaTiers: async () => ({}), donateHonghuaLove: async () => ({}) };
            }
            throw new Error(`未声明依赖 ${id}`);
        },
    });
    const prelude = `
        let starActivityClaimRunning = false;
        let loginReady = true;
        let friendSyncPaused = false;
        const getAutomation = () => ({ solar_terms_claim: true });
        const getInactiveActivityAutomationKeys = () => new Set();
        const __logs = [];
        const log = (tag, msg, meta) => __logs.push({ tag, msg, meta });
        const workerScheduler = { setTimeoutTask() {}, setIntervalTask() {}, clear() {} };
    `;
    vm.runInContext(prelude + milkTeaConsts + '\n' + source.slice(start, end) + '\n;globalThis.run = runStarActivityAutoClaims;', context);
    await context.run();
    assert.deepEqual(claimed, [403], '同一个 term 只能领取一次，不能把一个节令打成 12 次请求');
    assert.equal(starTouched.value, false);
});
