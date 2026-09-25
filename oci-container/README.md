This provides an image that has the 3 supported harness for usage of tamandua with matchlock. It also provides a docker image. Any of them can be used to use tamandua itself from within containers too.

Note: this image ships no ssh host keys and no /root/.ssh/authorized_keys — the base image bakes them deliberately for its own use, and this derived image removes them so consumers do not share one host identity or inherit a root access grant.
