import {build} from 'esbuild';
await build({entryPoints:['frontend/rich.js'],bundle:true,format:'esm',outfile:'public/rich.js',minify:true,legalComments:'eof',loader:{'.woff2':'file','.woff':'file','.ttf':'file'},assetNames:'fonts/[name]-[hash]'});
