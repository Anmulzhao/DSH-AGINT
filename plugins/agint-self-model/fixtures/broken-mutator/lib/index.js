// 故意破坏注入（self-model-isolation 静态检查应拦截）：引用写路径 Service
const forbidden = 'agint.mutator';
export const probe = forbidden;
