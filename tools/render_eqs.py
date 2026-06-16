"""Render the story's equations to tight SVGs using the local LaTeX toolchain.
Run from web/:  python tools/render_eqs.py   (needs latex + dvisvgm on PATH)
Outputs assets/equations/<id>.svg (black glyph paths; the CSS inverts to white).
"""
import os, subprocess, tempfile, shutil, sys

EQS = {
    "frenet":        r"\mathbf{T}'=\omega\mathbf{N},\quad \mathbf{N}'=-\omega\mathbf{T}+\xi\mathbf{B},\quad \mathbf{B}'=-\xi\mathbf{N}",
    "voltage-curve": r"\mathbf{v}=-\boldsymbol{\varphi}'=\mathbf{x}',\qquad s'=\lvert\mathbf{v}\rvert=v",
    "rho":           r"\rho=\dfrac{v'}{v}=\dfrac{d}{dt}\ln\lvert\mathbf{v}\rvert",
    "azimuthal":     r"\boldsymbol{\omega}=\dfrac{\mathbf{v}\times\mathbf{v}'}{v^{2}},\qquad \mathbf{v}'=\rho\,\mathbf{v}+\boldsymbol{\omega}\times\mathbf{v}",
    "torsional":     r"\xi=v\,\tau",
    "complex":       r"\eta=\rho+j\,\omega=\dfrac{\mathbf{v}\,\dot{\mathbf{v}}}{v^{2}}",
}

TEMPLATE = r"""\documentclass[12pt]{article}
\usepackage{amsmath,amssymb}
\usepackage[active,tightpage]{preview}
\setlength\PreviewBorder{2pt}
\begin{document}
\begin{preview}
$\displaystyle %s$
\end{preview}
\end{document}
"""

here = os.path.dirname(os.path.abspath(__file__))
web = os.path.dirname(here)
outdir = os.path.join(web, "assets", "equations")
os.makedirs(outdir, exist_ok=True)

work = tempfile.mkdtemp(prefix="eqs_")
ok = []
for name, tex in EQS.items():
    base = os.path.join(work, name)
    with open(base + ".tex", "w", encoding="utf-8") as f:
        f.write(TEMPLATE % tex)
    r = subprocess.run(["latex", "-interaction=nonstopmode", "-halt-on-error",
                        "-output-directory", work, base + ".tex"],
                       capture_output=True, text=True)
    if not os.path.exists(base + ".dvi"):
        print(f"[FAIL] {name}: latex produced no dvi\n{r.stdout[-800:]}")
        continue
    out = os.path.join(outdir, name + ".svg")
    r2 = subprocess.run(["dvisvgm", "--no-fonts=1", "--exact", base + ".dvi", "-o", out],
                        capture_output=True, text=True)
    if os.path.exists(out):
        ok.append(name)
        print(f"[ok] {name}.svg")
    else:
        print(f"[FAIL] {name}: dvisvgm\n{r2.stderr[-800:]}")

shutil.rmtree(work, ignore_errors=True)
print(f"\nRendered {len(ok)}/{len(EQS)} -> {outdir}")
sys.exit(0 if len(ok) == len(EQS) else 1)
