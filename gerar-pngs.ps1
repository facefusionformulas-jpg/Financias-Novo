Add-Type -AssemblyName System.Drawing

function New-Icon($size, $path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $radius = [int]($size * 0.156)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(0x1f, 0x29, 0x37),
        [System.Drawing.Color]::FromArgb(0x0f, 0x17, 0x2a),
        45.0
    )

    $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path2.AddArc(0, 0, $radius*2, $radius*2, 180, 90)
    $path2.AddArc($size - $radius*2, 0, $radius*2, $radius*2, 270, 90)
    $path2.AddArc($size - $radius*2, $size - $radius*2, $radius*2, $radius*2, 0, 90)
    $path2.AddArc(0, $size - $radius*2, $radius*2, $radius*2, 90, 90)
    $path2.CloseFigure()

    $g.FillPath($brush, $path2)

    $azul = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x60, 0xa5, 0xfa))
    $g.FillRectangle($azul, [int]($size * 0.24), [int]($size * 0.18), [int]($size * 0.52), [int]($size * 0.03))

    $verde = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x34, 0xd3, 0x99))
    $g.FillRectangle($verde, [int]($size * 0.24), [int]($size * 0.79), [int]($size * 0.52), [int]($size * 0.03))

    $fontSize = [float]($size * 0.55)
    $font = New-Object System.Drawing.Font("Georgia", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $branco = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0xf3, 0xf4, 0xf6))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString("F", $font, $branco, $rect, $sf)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose(); $bmp.Dispose(); $brush.Dispose()
    $azul.Dispose(); $verde.Dispose(); $branco.Dispose()
    $font.Dispose(); $path2.Dispose()
}

$dir = "C:\Users\distr\Downloads\financas-app\icons"
New-Icon 192 "$dir\icon-192.png"
New-Icon 512 "$dir\icon-512.png"
Write-Host "Gerado: $dir\icon-192.png e $dir\icon-512.png"
