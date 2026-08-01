//go:build ignore

package util

import (
	"archive/tar"
	"io"
	"os"
	"path/filepath"
)

// ExtractTar extracts tar entries from r to the destination directory dest.
//
// VULNERABLE (VULN-G2): header.Name is used directly in filepath.Join(dest, header.Name)
// without validation. A tar archive containing entries named ../../etc/passwd
// would write files outside the dest directory via path traversal.
func ExtractTar(r io.Reader, dest string) error {
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		// VULN-G2: no path traversal check — header.Name used directly.
		target := filepath.Join(dest, hdr.Name)

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		}
	}
}
