# Rebuild the approved brand PNGs without network access or external dependencies.
# Run with Windows PowerShell; System.Drawing uses the existing Windows GDI+ stack.
param([string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# Remove the source's white matte; keep opaque interior colors unchanged.
# Edge pixels are unmatted against their nearest opaque neighbor before resize.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
public static class WorkbenchBrand {
    public static Bitmap Transparent(Bitmap source) {
        int w=source.Width, h=source.Height;
        var colors=new Color[w*h]; var background=new bool[w*h];
        var interior=new bool[w*h];
        for(int y=0;y<h;y++) for(int x=0;x<w;x++) {
            int i=y*w+x; var c=source.GetPixel(x,y); colors[i]=c;
            int lo=Math.Min(c.R,Math.Min(c.G,c.B)), hi=Math.Max(c.R,Math.Max(c.G,c.B));
            background[i]=lo>=242 && hi-lo<=12;
        }
        for(int y=2;y<h-2;y++) for(int x=2;x<w-2;x++) {
            int i=y*w+x; if(background[i]) continue;
            bool solid=true;
            for(int dy=-2;dy<=2;dy++) for(int dx=-2;dx<=2;dx++)
                if(background[(y+dy)*w+x+dx]) solid=false;
            interior[i]=solid;
        }
        var result=new Bitmap(w,h,System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        for(int y=0;y<h;y++) for(int x=0;x<w;x++) {
            int i=y*w+x; if(background[i]) continue;
            var c=colors[i];
            if(!interior[i]) {
                int nearest=999; Color sample=c;
                for(int dy=-5;dy<=5;dy++) for(int dx=-5;dx<=5;dx++) {
                    int nx=x+dx,ny=y+dy,d=dx*dx+dy*dy;
                    if(nx<0||nx>=w||ny<0||ny>=h||d>=nearest||!interior[ny*w+nx]) continue;
                    nearest=d; sample=colors[ny*w+nx];
                }
                if(nearest<999) {
                    int channel=sample.R<=sample.G && sample.R<=sample.B ? 0 : sample.G<=sample.B ? 1 : 2;
                    int foreground=channel==0?sample.R:channel==1?sample.G:sample.B;
                    int observed=channel==0?c.R:channel==1?c.G:c.B;
                    double a=Math.Min(1,(255-observed)/(double)Math.Max(1,255-foreground));
                    if(a<0.01) continue;
                    c=Color.FromArgb(Clamp(a*255),Clamp((c.R-255*(1-a))/a),Clamp((c.G-255*(1-a))/a),Clamp((c.B-255*(1-a))/a));
                }
            }
            result.SetPixel(x,y,c);
        }
        return result;
    }
    static int Clamp(double n) { return Math.Max(0,Math.Min(255,(int)Math.Round(n))); }
}
'@
$source = Join-Path $RepositoryRoot 'assets/branding/antigravity-workbench-a-original.png'
$expected = 'ea22ed5c8920fe8fa76ef4151b80f7e37a3ed7ec6b8eaa798a8d1ea59bc041a6'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Approved brand source changed; review the source before regenerating.'
}
$original = [System.Drawing.Bitmap]::new($source)
$transparent = $null
try {
    if ($original.Width -ne 1254 -or $original.Height -ne 1254) { throw 'Unexpected source dimensions' }
    $transparent = [WorkbenchBrand]::Transparent($original)
    $outputs = @(@{Name='icon.png';Size=256}, @{Name='brand-logo.png';Size=512})
    foreach ($output in $outputs) {
        $size = $output.Size
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
        try {
            $bitmap.SetResolution(96, 96)
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            # Source colored bounds: x=101..1159, y=178..1089. Center the entire
            # unchanged mark (including its base), preserving scale and all parts.
            $graphics.TranslateTransform(-3.5*$size/1254, -7*$size/1254)
            $rectangle = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
            $graphics.DrawImage($transparent, $rectangle, 0, 0, $original.Width, $original.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
            $target = Join-Path $RepositoryRoot ('media/' + $output.Name)
            $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
            [pscustomobject]@{Path=$output.Name;Width=$size;Height=$size;SHA256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()}
        } finally {
            $attributes.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    if ($transparent) { $transparent.Dispose() }
    $original.Dispose()
}
