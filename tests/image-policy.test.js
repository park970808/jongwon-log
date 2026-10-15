// 사진 줄이기 정책: 휴대폰 원본은 줄이고 회전 정보를 반영, 작은 PNG·JPEG는 그대로 둡니다.
import test from 'node:test';import assert from 'node:assert/strict';
import {planImage,jpegOrientation,IMAGE} from '../src/image-policy.js';

function exifJpeg(orientation,little=false){
  const u16=n=>little?[n&255,n>>8]:[n>>8,n&255],u32=n=>little?[n&255,(n>>8)&255,(n>>16)&255,n>>>24]:[n>>>24,(n>>16)&255,(n>>8)&255,n&255];
  const tiff=[...(little?[0x49,0x49]:[0x4d,0x4d]),...u16(42),...u32(8),...u16(1),...u16(0x0112),...u16(3),...u32(1),...u16(orientation),0,0,...u32(0)];
  const app1=[0x45,0x78,0x69,0x66,0,0,...tiff];
  return new Uint8Array([0xff,0xd8,0xff,0xe1,...[(app1.length+2)>>8,(app1.length+2)&255],...app1,0xff,0xda,0,2]);
}

test('EXIF orientation is read from phone JPEGs (both byte orders) and defaults to 1',()=>{
  assert.equal(jpegOrientation(exifJpeg(6)),6);assert.equal(jpegOrientation(exifJpeg(3,true)),3);
  assert.equal(jpegOrientation(new Uint8Array([0xff,0xd8,0xff,0xda,0,2])),1);
  assert.equal(jpegOrientation(new Uint8Array([0x89,0x50,0x4e,0x47])),1,'not a JPEG');
  assert.equal(jpegOrientation(exifJpeg(6).slice(0,20)),1,'truncated header');
});

test('phone photos are shrunk to the maximum edge; small screenshots are kept as they are',()=>{
  const phone=planImage({type:'image/jpeg',size:4_800_000,width:4032,height:3024,orientation:6});
  assert.deepEqual(phone,{reencode:true,width:2000,height:1500,type:'image/jpeg'});
  assert.deepEqual(planImage({type:'image/png',size:300_000,width:1280,height:720}),{reencode:false});
  assert.deepEqual(planImage({type:'image/jpeg',size:900_000,width:1600,height:1200}),{reencode:false});
  assert.equal(planImage({type:'image/jpeg',size:900_000,width:1600,height:1200,orientation:6}).reencode,true,'rotation must be applied');
  assert.equal(planImage({type:'image/jpeg',size:2_500_000,width:1800,height:1200}).reencode,true,'too many bytes at a small size');
  assert.equal(planImage({type:'image/webp',size:100_000,width:800,height:600}).type,'image/jpeg','formats Hangul may not read are converted');
  assert.equal(planImage({type:'image/png',size:3_000_000,width:3000,height:2000}).type,'image/png','PNG first tries PNG (text stays sharp)');
  const tall=planImage({type:'image/jpeg',size:5e6,width:3000,height:9000});assert.equal(tall.height,IMAGE.maxEdge);assert.equal(tall.width,667);
});
