//! The complete privilege surface: one operation, fixed packages, no caller supplied commands.
//! Shared by the desktop app and the separately installed, root-owned helper binary.
use std::path::Path;

pub const HELPER: &str = "/usr/libexec/gentle-dot/privileged-helper";
pub const POLICY: &str = "/usr/share/polkit-1/actions/dev.gentledot.install-browser.policy";
pub const PKEXEC: &str = "/usr/bin/pkexec";
pub const READY: &[u8] = b"GENTLE_DOT_READY_V1\n";
pub const PROCEED: &[u8] = b"INSTALL_CHROMIUM_V1\n";

#[derive(Debug, PartialEq, Eq)]
pub struct InstallPlan {
    pub program: &'static str,
    pub args: &'static [&'static str],
}

pub fn install_plan(os_release: &str) -> Option<InstallPlan> {
    if os_release.len() > 16384 {
        return None;
    }
    let field = |name: &str| -> Option<&str> {
        let mut values = os_release
            .lines()
            .filter_map(|line| line.strip_prefix(name));
        let value = values.next()?.trim().trim_matches('"').trim_matches('\'');
        if values.next().is_some()
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'_' || b == b'-')
        {
            return None;
        }
        Some(value)
    };
    let id = field("ID=")?;
    let like = field("ID_LIKE=").unwrap_or("");
    if id == "arch" || like.split_whitespace().any(|id| id == "arch") {
        Some(InstallPlan {
            program: "/usr/bin/pacman",
            args: &["-S", "--needed", "--noconfirm", "chromium"],
        })
    } else if id == "debian" {
        Some(InstallPlan {
            program: "/usr/bin/apt-get",
            args: &["install", "--yes", "--no-install-recommends", "chromium"],
        })
    } else if id == "fedora" {
        Some(InstallPlan {
            program: "/usr/bin/dnf",
            args: &["install", "--assumeyes", "chromium"],
        })
    } else {
        None
    }
}

/// Inspect every path component. Symlinks, writable ancestors, non-root owners and special files
/// are refused. Used only for fixed system paths, never paths supplied by a caller.
#[cfg(unix)]
pub fn trusted_file(path: &Path, executable: bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() {
        return false;
    }
    for component in path.ancestors() {
        let Ok(metadata) = std::fs::symlink_metadata(component) else {
            return false;
        };
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 || metadata.file_type().is_symlink()
        {
            return false;
        }
        if component == path {
            if !metadata.is_file() || (executable && metadata.mode() & 0o111 == 0) {
                return false;
            }
        } else if !metadata.is_dir() {
            return false;
        }
    }
    true
}

#[cfg(not(unix))]
pub fn trusted_file(_path: &Path, _executable: bool) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_manifest_uses_only_exact_packages() {
        assert_eq!(
            install_plan("ID=debian").unwrap().args.last(),
            Some(&"chromium")
        );
        assert_eq!(install_plan("ID=fedora").unwrap().program, "/usr/bin/dnf");
        let arch = install_plan("ID=cachyos\nID_LIKE=\"arch\"").unwrap();
        assert_eq!(arch.program, "/usr/bin/pacman");
        assert_eq!(arch.args, ["-S", "--needed", "--noconfirm", "chromium"]);
    }
    #[test]
    fn unknown_or_ambiguous_distributions_fail_closed() {
        for text in [
            "",
            "ID=ubuntu",
            "ID=debian\nID=fedora",
            "ID=$(whoami)",
            "ID=foo\nID_LIKE=notarch",
            "ID=foo\nID_LIKE=arch;evil",
        ] {
            assert_eq!(install_plan(text), None, "{text}");
        }
    }
    #[test]
    fn relative_and_user_writable_paths_are_untrusted() {
        assert!(!trusted_file(Path::new("bin/tool"), true));
        assert!(!trusted_file(Path::new("/tmp"), true));
        assert!(!trusted_file(Path::new("/does/not/exist"), false));
    }
}
