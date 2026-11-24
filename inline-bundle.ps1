# Read bundle.js
$bundleJs = Get-Content "g:\htm_file\esp32_flash\esptool-js\bundle.js" -Raw

# Read the HTML template
$htmlContent = Get-Content "g:\htm_file\esp32_flash\esptool-js\dist\flash-standalone.html" -Raw

# Remove the CDN script tag and replace with inline bundle
$htmlContent = $htmlContent -replace '<script src="https://cdn\.jsdelivr\.net/npm/esptool-js@0\.6\.0/lib/index\.js"></script>', ("<script>`r`n" + $bundleJs + "`r`n</script>")

# Write the new HTML file
$htmlContent | Set-Content "g:\htm_file\esp32_flash\esptool-js\dist\flash-standalone.html" -NoNewline

Write-Host "Bundle inlined successfully!"
Write-Host "File size: $((Get-Content 'g:\htm_file\esp32_flash\esptool-js\dist\flash-standalone.html').Length) bytes"
