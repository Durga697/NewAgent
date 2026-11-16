let csrfToken='';
export function setCsrfToken(token){csrfToken=typeof token==='string'?token:'';}
export function csrfHeaders(){return {'X-Edith-CSRF':csrfToken};}
