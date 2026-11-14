import {it,expect,vi,afterEach} from 'vitest';
import {createSQLiteD1} from '../gateway-core/sqlite-adapter.js';
vi.mock('cloudflare:sockets',()=>({connect:vi.fn()}));
vi.mock('../../src/service/gateway-connectivity.js',()=>({probeGateway:vi.fn(async()=>({ok:true,code:'OK',stages:{dns:'passed',secureConnection:'passed',protocol:'passed'}}))}));
vi.mock('../../src/service/user-service',()=>({default:{updateUserInfo:async()=>{}}}));
vi.mock('../../src/service/perm-service',()=>({default:{userPermKeys:async()=>['setting:set']}}));
vi.mock('../../src/utils/jwt-utils',()=>({default:{verifyToken:async(_c,token)=>token ? {userId:token,token,gen:'fixture-gen'} : null}}));
vi.mock('../../src/i18n/i18n',()=>({t:key=>key}));
import app from '../../src/hono/hono.js';
import '../../src/security/security.js';
import '../../src/api/gateway-connectivity-api.js';
import {probeGateway} from '../../src/service/gateway-connectivity.js';
import constant from '../../src/const/constant.js';
import KvConst from '../../src/const/kv-const.js';
const databases=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.clearAllMocks();});
function fixture(){
	constant.AUTH_GEN='fixture-gen';
	const db=createSQLiteD1();databases.push(db);
	db.sqlite.exec("CREATE TABLE setting (gateway_imap_hostname TEXT,gateway_smtp_hostname TEXT); INSERT INTO setting VALUES ('imap.example.test','smtp.example.test');");
	const env={db,admin:'admin@example.test',kv:{async get(key){const token=key.slice(KvConst.AUTH_INFO.length);return ['admin','user'].includes(token)?{tokens:[token],refreshTime:new Date().toISOString(),user:{userId:token,email:token+'@example.test'}}:null;}}};
	return {db,env,request:(path='imap',token='admin',options={})=>app.request('/setting/gatewayConnectivity/'+path,{method:'POST',headers:token?{[constant.TOKEN_HEADER]:token}:{},...options},env)};
}
it('actual JWT middleware rejects anonymous, invalid and ordinary user including delegated setting permission',async()=>{
	const f=fixture();
	for(const [token,status] of [[null,401],['invalid',401],['user',403]]){const response=await f.request('imap',token);expect(response.status).toBe(status);expect(response.headers.get('Cache-Control')).toBe('no-store');}
	expect(probeGateway).not.toHaveBeenCalled();
});
it('accepts only bodyless fixed protocol requests, selects only saved hostname and never gates on visibility',async()=>{
	const f=fixture();
	for(const [path,options] of [['imap?host=mail.example.test',{}],['smtp',{body:'{}'}],['imap',{body:JSON.stringify({host:'192.0.2.1',port:25})}],['other',{}]])expect((await f.request(path,'admin',options)).status).toBe(400);
	expect(probeGateway).not.toHaveBeenCalled();
	for(const protocol of ['imap','smtp']){const response=await f.request(protocol);expect(response.status).toBe(200);expect(probeGateway).toHaveBeenCalledWith(protocol,protocol+'.example.test',expect.objectContaining({connect:expect.any(Function)}));}
});
it('global D1 cooldown is atomic and independently limits both protocols across requests',async()=>{
	const f=fixture();
	const responses=await Promise.all([f.request(),f.request()]);expect(responses.map(r=>r.status).sort()).toEqual([200,429]);
	expect((await f.request('smtp')).status).toBe(200);expect((await f.request('smtp')).status).toBe(429);
	f.db.sqlite.exec('UPDATE gateway_probe_cooldown SET until_ms=0');expect((await f.request()).status).toBe(200);
});
it('database failure returns only fixed safe code',async()=>{
	const f=fixture();f.env.db={prepare(){throw new Error('synthetic secret');}};
	const response=await f.request();expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret');
});
