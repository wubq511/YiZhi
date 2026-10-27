import {protocol} from 'electron';
import type {CourseService} from '../core/course-service';
/** Registered course bytes only. This scheme has no preload and cannot fetch host resources. */
export function registerExtensionProtocol(core:CourseService) {
  protocol.handle('yizhi-extension',async request=>{
    try {
      const url=new URL(request.url),m=/^\/([a-f0-9-]{36})\/(1\.0\.0|1\.1\.0|2\.0\.0)\/([a-zA-Z.]+)$/.exec(url.pathname);
      if(request.method!=='GET'||url.hostname!=='package'||url.username||url.password||url.search||!m)throw Error('未登记');
      const r=await core.extensions.resource({sessionId:m[1],version:m[2] as any,path:m[3]});
      return new Response(r.bytes as Uint8Array<ArrayBuffer>,{headers:{'Content-Type':r.mediaType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors yizhi-app://app"}});
    }catch{return new Response('扩展资源未登记或已损坏',{status:404});}
  });
}
export function extensionNavigation(url:string) {
  return /^yizhi-extension:\/\/package\/[a-f0-9-]{36}\/(1\.0\.0|1\.1\.0|2\.0\.0)\/index\.html$/.test(url);
}
