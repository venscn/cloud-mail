import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import * as Vue from 'vue'
import {renderToString} from 'vue/server-renderer'
import {compileTemplate,parse} from 'vue/compiler-sfc'
import {canManageGatewaySettings} from '../src/components/gateway-admin-settings/gateway-admin-access.js'
import zh from '../src/i18n/gateway-zh.js'
import en from '../src/i18n/gateway-en.js'
const read = file => readFileSync(new URL(file,import.meta.url),'utf8')
const personal=read('../src/components/gateway-settings/index.vue')
const admin=read('../src/components/gateway-admin-settings/index.vue')
function renderer(source){
    const {descriptor}=parse(source)
    const {code,errors}=compileTemplate({source:descriptor.template.content,filename:'audience.vue',id:'audience-test'})
    assert.deepEqual(errors,[])
    const executable=code.replace(/import \{([^}]+)\} from "vue"/g,(_,bindings)=>`const {${bindings.replace(/\bas\b/g,':')}}=Vue`).replace('export function render','function render')
    return runInNewContext(executable+'\n;render',{Vue})
}
async function render(source,context,labels){
    const app=Vue.createSSRApp({setup:()=>context,render:renderer(source)})
    app.config.globalProperties.$t=(key,values={})=>(labels[key] || key).replace(/\{(\w+)\}/g,(_,name)=>values[name])
    const tags=[...new Set([...source.matchAll(/<(el-[a-z-]+)/g)].map(match=>match[1]))]
    for(const tag of tags)app.component(tag,{inheritAttrs:false,setup:(_props,{attrs,slots})=>()=>Vue.h(tag==='el-button'?'button':'div',attrs,tag==='el-table-column'?undefined:slots.default?.())})
    return renderToString(app)
}
const config={imapHostname:'imap.example.test',smtpHostname:'smtp.example.test'}
const noop=()=>{}
function personalContext(){return {
    gatewayConfig:config,loading:false,creating:false,revokingId:'',oneTimeSecret:null,errorKey:'',ready:true,
    accounts:[{accountId:'1',email:'alice@example.test'}],accountsErrorKey:'',selectedAccountId:'1',selectedAccount:{email:'alice@example.test'},credentialName:'Phone',canSend:true,requestedPermissions:['mail.read'],visibleAppPasswords:[],
    actionErrorKey:'',createOutcomeUnknown:false,submissions:[],submissionsLoading:false,submissionsErrorKey:'',
    refresh:noop,refreshSubmissions:noop,createCredential:noop,selectAccount:noop,confirmRevoke:noop,clearSecret:noop,copyPassword:noop,permissionLabel:()=>'',formatTime:()=>'',submissionPresentation:()=>({}),
}}
function adminContext(user){return {canManageSettings:canManageGatewaySettings(user),enabled:1,...config,saving:false,disabled:false,errorKey:'',saveSettings:noop,
    tests:{imap:{pending:false,cooldown:false,code:''},smtp:{pending:false,cooldown:false,code:''}},connectivity:{blocked:()=>false,dirty:()=>false,testConnection:noop}}}
test('personal setup lists each server once only inside client instructions and retains device/password actions',async()=>{
    for(const labels of [zh,en]){
        const html=await render(personal,personalContext(),labels)
        assert.equal(html.split(config.imapHostname).length-1,1);assert.equal(html.split(config.smtpHostname).length-1,1)
        assert.ok(html.indexOf(config.imapHostname)>html.indexOf(labels.gatewayClientSetup))
        for(const key of ['gatewayCreatePassword','gatewayPasswordList','gatewayCredentialName','gatewayPermissionRead','gatewayIosStep2'])assert.ok(html.includes(labels[key]))
        for(const key of ['gatewayNoMxChange','gatewayDeploymentRequired','gatewayAdminSmtpAlternative','gatewayProbeHint'])assert.ok(!html.includes(labels[key]))
        assert.doesNotMatch(html,/\bMX\b|STARTTLS|协议桥接|send channels|storage, quotas|gatewayProbe/)
    }
    assert.equal((personal.match(/gatewayConfig\.imapHostname/g)||[]).length,1)
    assert.equal((personal.match(/gatewayConfig\.smtpHostname/g)||[]).length,1)
    assert.match(personal,/data-testid="one-time-password"/)
    assert.match(personal,/@click="confirmRevoke\(row\)"/)
})
test('system-settings technical instructions fail closed for unloaded, ordinary and malformed roles',async()=>{
    for(const user of [undefined,{}, {permKeys:[]},{permKeys:['mail.read','email:send']},{permKeys:'*'}]){
        assert.equal(canManageGatewaySettings(user),false)
        for(const labels of [zh,en]){
            const html=await render(admin,adminContext(user),labels)
            assert.ok(!html.includes(labels.gatewayNoMxChange));assert.ok(!html.includes(labels.gatewayDeploymentRequired));assert.ok(!html.includes('test-imap'));assert.ok(!html.includes('test-smtp'))
        }
    }
})
test('existing wildcard/system-settings permission retains admin host inputs, both tests and operational constraints',async()=>{
    for(const user of [{permKeys:['*']},{permKeys:['setting:query']}]){
        for(const labels of [zh,en]){
            const html=await render(admin,adminContext(user),labels)
            for(const key of ['gatewayNoMxChange','gatewayDeploymentRequired','gatewayAdminSmtpAlternative','gatewayProbeImap','gatewayProbeSmtp'])assert.ok(html.includes(labels[key]))
            assert.ok(html.includes('test-imap')&&html.includes('test-smtp'))
        }
    }
    assert.match(admin,/canManageGatewaySettings\(userStore\.user\)/)
    assert.match(admin,/v-if="canManageSettings"/)
    const permissions=read('../src/perm/perm.js')
    assert.match(permissions,/'setting:query': \[\{\s*path: '\/system-settings'/)
    assert.match(admin,/v-model="imapHostname"/);assert.match(admin,/v-model="smtpHostname"/)
    assert.deepEqual(Object.keys(zh).sort(),Object.keys(en).sort())
})
