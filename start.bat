@echo off
chcp 65001 >nul
rem ============================================================
rem 合肥市区县-街道地图 一键本地启动
rem 说明：高德 JS API 2.0 使用安全密钥鉴权，会校验来源域名，
rem       双击 index.html（file://）可能被拒，推荐用本脚本启动。
rem       启动后浏览器自动打开 http://localhost:8080
rem ============================================================
cd /d "%~dp0"
start "" "http://localhost:8080/"
python -m http.server 8080
