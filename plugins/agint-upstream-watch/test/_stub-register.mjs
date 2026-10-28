// 注册测试期裸包重定向 hook。见 _stub-loader.mjs 顶部的取证与理由。
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

register(pathToFileURL(join(import.meta.dirname, '_stub-loader.mjs')).href);
