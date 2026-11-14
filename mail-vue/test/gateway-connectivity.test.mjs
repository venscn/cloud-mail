import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import * as Vue from 'vue'
import {renderToString} from 'vue/server-renderer'
import {parse,compileTemplate} from 'vue/compiler-sfc'
import {useGatewayConnectivity} from '../src/components/gateway-admin-settings/use-gateway-connectivity.js'
import zh from '../src/i18n/gateway-zh.js'
import en from '../src/i18n/gateway-en.js'
const hosts = {gatewayEnabled:0,gatewayImapHostname:'imap.example.test',gatewaySmtpHostname:'smtp.example.test'}
const success = {ok:true,code:'OK',stages:{dns:'passed',secureConnection:'passed',protocol:'passed'}}
function fixture(request = async () => success) {
    const settings=Vue.ref({...hosts}), drafts={imap:Vue.ref(hosts.gatewayImapHostname),smtp:Vue.ref(hosts.gatewaySmtpHostname)},saving=Vue.ref(false),disabled=Vue.ref(false)
    const state=useGatewayConnectivity(settings,drafts,saving,request,()=>disabled.value)
    return {settings,drafts,saving,disabled,state}
}
test('independent single-side pending prevents duplicate calls without disabling the other service',async()=>{
    const calls=[],finish={}
    const f=fixture((protocol,signal)=>{calls.push({protocol,signal});return new Promise(resolve=>{finish[protocol]=resolve})})
    try {
        const imap=f.state.testConnection('imap'); assert.equal(f.state.tests.imap.pending,true);assert.equal(f.state.tests.smtp.pending,false)
        assert.equal(await f.state.testConnection('imap'),false);assert.equal(calls.length,1)
        const smtp=f.state.testConnection('smtp');assert.deepEqual(calls.map(c=>c.protocol),['imap','smtp']);assert.ok(calls.every(c=>c.signal instanceof AbortSignal))
        finish.imap(success);assert.equal(await imap,true);assert.equal(f.state.tests.smtp.pending,true)
        finish.smtp({...success,ok:false,code:'PROTOCOL_FAILED'});assert.equal(await smtp,false)
        assert.equal(f.state.tests.imap.code,'OK');assert.equal(f.state.tests.smtp.code,'PROTOCOL_FAILED')
        assert.equal(await f.state.testConnection('imap'),false)
    } finally {f.state.dispose()}
})
test('dirty side, loading, missing config and saving cannot make requests',async()=>{
    let calls=0;const f=fixture(async()=>{calls++;return success})
    try {
        f.drafts.imap.value='changed.example.test';assert.equal(f.state.dirty('imap'),true);assert.equal(await f.state.testConnection('imap'),false)
        f.saving.value=true;assert.equal(await f.state.testConnection('smtp'),false)
        f.saving.value=false;f.disabled.value=true;assert.equal(await f.state.testConnection('smtp'),false)
        f.disabled.value=false;f.settings.value.gatewaySmtpHostname='';f.drafts.smtp.value='';assert.equal(await f.state.testConnection('smtp'),false)
        assert.equal(calls,0)
    } finally {f.state.dispose()}
})
test('draft or saved-host changes clear only stale results and abort in-flight responses',async()=>{
    let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve}))
    try {
        const pending=f.state.testConnection('imap');f.drafts.imap.value='changed.example.test';finish(success)
        assert.equal(await pending,false);assert.equal(f.state.tests.imap.result,null);assert.equal(f.state.tests.imap.code,'')
        f.state.tests.smtp.result={...success};f.state.tests.smtp.code='OK'
        f.settings.value.gatewaySmtpHostname='new.example.test';assert.equal(f.state.tests.smtp.result,null);assert.equal(f.state.tests.smtp.code,'')
    } finally {f.state.dispose()}
})
test('disposal cancels requests and late success cannot reappear',async()=>{
    let finish,signal;const f=fixture((_p,s)=>{signal=s;return new Promise(resolve=>{finish=resolve})})
    const pending=f.state.testConnection('smtp');f.state.dispose();assert.equal(signal.aborted,true);finish(success)
    assert.equal(await pending,false);assert.equal(f.state.tests.smtp.code,'')
})
test('only fixed localized codes and stages survive errors; malformed success is not green',async()=>{
    for(const response of [()=>{throw {message:'synthetic secret',config:{password:'synthetic'}}},()=>({ok:true,code:'OK',stages:{dns:'passed'}}),()=>({ok:true,code:'unknown banner',stages:success.stages})]) {
        const f=fixture(response);try {assert.equal(await f.state.testConnection('imap'),false);assert.equal(f.state.tests.imap.code,'UNAVAILABLE');assert.ok(!JSON.stringify(f.state.tests).includes('synthetic'))}finally{f.state.dispose()}
    }
    const f=fixture(()=>{throw {message:'FORBIDDEN'}});try{await f.state.testConnection('imap');assert.equal(f.state.tests.imap.code,'FORBIDDEN')}finally{f.state.dispose()}
})
test('production request is bodyless, whitelisted and suppresses raw global error messages',()=>{
    const source=readFileSync(new URL('../src/request/setting.js',import.meta.url),'utf8')
    assert.match(source,/\['imap','smtp'\]\.includes\(protocol\)/)
    assert.match(source,/http\.post\(`\/setting\/gatewayConnectivity\/\$\{protocol\}`, undefined/)
    assert.match(source,/timeout: 15000, noMsg: true, validateStatus: \(\) => true/)
})
test('production admin template SSR shows two independent controls, dirty/loading states and localized phase results',async()=>{
    const source=readFileSync(new URL('../src/components/gateway-admin-settings/index.vue',import.meta.url),'utf8')
    const {descriptor}=parse(source)
    const {code,errors}=compileTemplate({source:descriptor.template.content,filename:'gateway-admin.vue',id:'probe-ssr'})
    assert.deepEqual(errors,[])
    const executable=code.replace(/import \{([^}]+)\} from "vue"/g,(_,bindings)=>`const {${bindings.replace(/\bas\b/g,':')}}=Vue`).replace('export function render','function render')
    const render=runInNewContext(executable+'\n;render',{Vue})
    for(const labels of [zh,en]) {
        const f=fixture();f.drafts.imap.value='unsaved.example.test';f.state.tests.smtp.code='CONNECT_TLS_FAILED';f.state.tests.smtp.result={ok:false,stages:{dns:'passed',secureConnection:'failed',protocol:'pending'}}
        const app=Vue.createSSRApp({setup:()=>({enabled:0,imapHostname:f.drafts.imap,smtpHostname:f.drafts.smtp,saving:false,errorKey:'',disabled:true,tests:f.state.tests,connectivity:f.state,saveSettings:()=>{}}),render})
        app.config.globalProperties.$t=key=>labels[key] || key
        for(const tag of ['el-form','el-form-item','el-input','el-switch','el-button','el-alert'])app.component(tag,{inheritAttrs:false,setup:(_props,{attrs,slots})=>()=>Vue.h(tag==='el-button'?'button':'div',attrs,slots.default?.())})
        try {
            const html=await renderToString(app)
            assert.match(html,/data-testid="test-imap"/);assert.match(html,/data-testid="test-smtp"/)
            assert.ok(html.includes(labels.gatewayProbeSaveFirst));assert.ok(html.includes(labels.gatewayProbePhase_secureConnection));assert.ok(html.includes(labels.gatewayProbeCode_CONNECT_TLS_FAILED))
            assert.doesNotMatch(html,/gatewayProbeCode_|gatewayProbeStatus_|undefined/)
        } finally {f.state.dispose()}
    }
    assert.deepEqual(Object.keys(zh).sort(),Object.keys(en).sort())
})
