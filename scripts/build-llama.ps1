# Builds the llama.cpp runtime used for the GGUF build of Jais-ASR.
#
# Jais-ASR's audio projector (`jais-asr`) is not in upstream llama.cpp, so the
# MBZUAI-IFM fork plus the patch published with the GGUF repository is required.
# The fork also predates the K2-Horizon pre-tokenizer, so patches/llama-k2-splitter.patch
# is applied on top (MSVC's std::regex rejects the model's \p{..}/\u200C pattern).
#
#   .\scripts\build-llama.ps1                  # CPU build (slow, fallback only)
#   .\scripts\build-llama.ps1 -Backend vulkan  # needs the LunarG Vulkan SDK (glslc)
#   .\scripts\build-llama.ps1 -Backend cuda    # needs the CUDA toolkit (nvcc)
#
# Vulkan is the shipped backend: it runs on NVIDIA and AMD through the installed
# graphics driver, so users need no CUDA toolkit. Install the SDK first
# (`winget install KhronosGroup.VulkanSDK`) and pass -VulkanSdk if it is not in
# the default location.
#
# Output: resources/llama/ (llama-server.exe, its DLLs, backend.txt).

param(
  [ValidateSet('cpu', 'vulkan', 'cuda')]
  [string]$Backend = 'vulkan',
  [string]$Work = 'H:\llama-jais',
  [string]$VulkanSdk = $env:VULKAN_SDK
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $Work 'src'
$commit = '35999d101cf2233fc54f09c3c8d599da7303ce02'
$tarball = Join-Path $Work 'llama-fork.tar.gz'
$patchFile = Join-Path $src 'jais.patch'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$scripts = Join-Path $env:APPDATA 'Python\Python312\Scripts'
$cmake = Join-Path $scripts 'cmake.exe'
$ninja = Join-Path $scripts 'ninja.exe'

New-Item -ItemType Directory -Force -Path $Work | Out-Null

if (-not (Test-Path $tarball)) {
  Write-Host "fetching fork at $commit"
  curl.exe -L --fail -o $tarball "https://codeload.github.com/MBZUAI-IFM/llama.cpp/tar.gz/$commit"
}
if (-not (Test-Path $src)) {
  New-Item -ItemType Directory -Path $src | Out-Null
  tar -xzf $tarball -C $src --strip-components=1
  curl.exe -L --fail -o $patchFile 'https://huggingface.co/IFM/Jais-ASR-GGUF/resolve/main/llama.cpp-jais-asr.patch'
  Push-Location $src
  git apply -p1 jais.patch
  $k2 = Join-Path $root 'patches\llama-k2-splitter.patch'
  git apply -p1 $k2
  Pop-Location
}

$flags = @(
  '-G', 'Ninja',
  "-DCMAKE_MAKE_PROGRAM=$ninja",
  '-DCMAKE_BUILD_TYPE=Release',
  '-DLLAMA_CURL=OFF',
  '-DLLAMA_BUILD_TESTS=OFF',
  '-DLLAMA_BUILD_EXAMPLES=OFF'
)
$envPrefix = ''
switch ($Backend) {
  'cpu' { $flags += '-DGGML_VULKAN=OFF' }
  'cuda' { $flags += '-DGGML_CUDA=ON' }
  'vulkan' {
    if (-not $VulkanSdk) {
      throw "Vulkan SDK not found. Install it (winget install KhronosGroup.VulkanSDK) or pass -VulkanSdk <path>."
    }
    if (-not (Test-Path (Join-Path $VulkanSdk 'Bin\glslc.exe'))) {
      throw "glslc.exe missing from $VulkanSdk\Bin. Is that the SDK root?"
    }
    $flags += '-DGGML_VULKAN=ON'
    # Without these CMake 4 fails with "Could NOT find Vulkan (missing: glslc)"
    # or "Could not find SPIRV-Headers".
    $envPrefix = "set `"VULKAN_SDK=$VulkanSdk`" && set `"CMAKE_PREFIX_PATH=$($VulkanSdk -replace '\\','/')`" && set `"SPIRV-Headers_DIR=$($VulkanSdk -replace '\\','/')/Lib/cmake`" && "
  }
}

$line = "call `"$vcvars`" >nul && $envPrefix cd /d `"$src`" && `"$cmake`" -B build-$Backend -DCMAKE_MAKE_PROGRAM=`"$ninja`" $($flags -join ' ')"
cmd /c $line
if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
$line = "call `"$vcvars`" >nul && $envPrefix cd /d `"$src`" && `"$cmake`" --build build-$Backend --target llama-server -j 8"
cmd /c $line
if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }

$out = Join-Path $root 'resources\llama'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -File | Remove-Item -Force
$bin = Join-Path $src "build-$Backend\bin"
Copy-Item (Join-Path $bin 'llama-server.exe') $out -Force
Get-ChildItem $bin -Filter '*.dll' | Copy-Item -Destination $out -Force
Copy-Item (Join-Path $src 'LICENSE') (Join-Path $out 'LICENSE-llama.cpp.txt') -Force
$Backend | Set-Content (Join-Path $out 'backend.txt') -Encoding ascii
Write-Host "installed $Backend build into $out"
