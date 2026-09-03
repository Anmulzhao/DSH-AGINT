// 故意破坏注入（self-model-isolation 静态检查应拦截）：写既有 agint_* 域
ctx.storageDomain.open({ name: 'agint_rules', version: 1 });
export const probe = 'agint_rules';
