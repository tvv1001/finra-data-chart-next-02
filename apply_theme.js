const fs = require('fs');
let css = fs.readFileSync('src/app/dashboard/dashboard.module.css', 'utf8');

// Colors mapping (heuristic)
css = css.replace(/#fff7f5|#ffe9e6|#f0f4ff|#f8fbff|#f8fafc|#ffffff|#fff/gi, '#080105');
css = css.replace(/#4a1114|#010b24|#0f172a|#334155|#475569/gi, '#cbd5e1');
css = css.replace(/linear-gradient\(135deg, #991b1b 0%, #dc2626 100%\)/g, 'linear-gradient(135deg, rgba(8, 0, 6, 0.95) 0%, rgba(16, 4, 11, 1) 100%)');
css = css.replace(/linear-gradient\(180deg, rgba\(33, 4, 10, 0\.98\) 0%, rgba\(79, 8, 19, 0\.98\) 100%\)/g, 'rgba(24, 6, 15, 0.98)');
css = css.replace(/rgba\(255, 255, 255, 0\.\d+\)/g, 'rgba(120, 20, 45, 0.28)'); // borders/overlays
css = css.replace(/border-radius:\s*\d+px/g, 'border-radius: 0px');
css = css.replace(/#dc2626|#1d4ed8|#2f65ea/gi, '#7c3aed'); // primary accents
css = css.replace(/#dbeafe|#eef2ff/gi, 'rgba(124, 58, 237, 0.15)'); // soft accents
css = css.replace(/box-shadow:[^;]+;/g, 'box-shadow: none;'); // remove shadows for flat look

fs.writeFileSync('src/app/dashboard/dashboard.module.css', css);
console.log('Applied theme');
