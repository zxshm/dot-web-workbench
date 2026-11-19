"""使用当前 Windows 用户的 DPAPI 保护工作台凭据。"""
import base64
import ctypes
from ctypes import wintypes
import sys


class DataBlob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def protect(data, decrypt=False):
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    operation.argtypes = [
        ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.POINTER(DataBlob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)
    ]
    operation.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    source_bytes = ctypes.create_string_buffer(data)
    source = DataBlob(len(data), ctypes.cast(source_bytes, ctypes.POINTER(ctypes.c_ubyte)))
    result = DataBlob()
    # 禁止系统弹出交互窗口，且不启用整机解密权限。
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        if decrypt:
            ctypes.memset(result.data, 0, result.size)
        kernel.LocalFree(result.data)


if __name__ == '__main__':
    value = sys.stdin.buffer.read()
    if sys.argv[1:] == ['seal']:
        sys.stdout.buffer.write(base64.b64encode(protect(value)))
    elif sys.argv[1:] == ['unseal']:
        sys.stdout.buffer.write(protect(base64.b64decode(value, validate=True), decrypt=True))
    else:
        raise SystemExit('请指定 seal 或 unseal。')
