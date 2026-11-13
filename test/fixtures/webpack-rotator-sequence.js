// webpack-obfuscator: rotasyon IIFE'si paket gövdesiyle aynı virgül ifadesinde; static-strings rotasyonu
// tanımadan rotasyonsuz model kurup checksum çağrılarını da değiştiriyordu (davranış geri alması)
function a(){var k=['8444XZeNlN','15453WtRkid','rotated-one','28AzeaRe','38006NhchNP','554034cTDcjO','1225ReLftd','245574IMyZGl','216220ThCdTz','log','66YRkMpH','rotated-two','rotated-three','1818825rxeenX','544WCmNiH'];a=function(){return k;};return a();}function b(c,d){c=c-0x125;var e=a();var f=e[c];return f;}(function(c,d){var i=b,e=c();while(!![]){try{var g=-parseInt(i(0x12d))/0x1+parseInt(i(0x12e))/0x2+-parseInt(i(0x127))/0x3+-parseInt(i(0x129))/0x4*(-parseInt(i(0x12f))/0x5)+parseInt(i(0x130))/0x6*(parseInt(i(0x12c))/0x7)+-parseInt(i(0x128))/0x8*(-parseInt(i(0x12a))/0x9)+-parseInt(i(0x131))/0xa*(-parseInt(i(0x133))/0xb);if(g===d)break;else e['push'](e['shift']());}catch(h){e['push'](e['shift']());}}}(a,0x88c07)),(()=>{var j=b;console[j(0x132)](j(0x12b),j(0x125)),console[j(0x132)](j(0x126));})();
// EXPECT: "rotated-one"
// EXPECT: "rotated-three"
// GONE: parseInt
// GONE: shift
